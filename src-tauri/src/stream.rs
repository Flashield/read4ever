/* 大文件流式播放协议 read4ever-stream://
   <video> 元素按 HTTP Range 语义分块拉取（seek 只读所需区间），
   单次响应封顶 MAX_CHUNK，2GB+ 视频不再整读进内存。
   目标经 percent-encode 编码在 URL 路径里：
   · 普通文件 = 完整路径（本地路径或 smb:// 远程路径；远程侧句柄常驻 + 并发分块读
     + 块间预取，见 smb.rs「流式播放」一节，断线自愈）；
   · zip 条目 = 「zip路径::条目名」（与前端复合路径同形），仅支持存储型（Stored）条目，
     压缩条目不可随机定位 → 返回错误，前端回退整读。
   无 Range 头的请求按 bytes=0- 处理（媒体元素总会带 Range；无 Range 时不封顶会整读大文件）。 */
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};

use crate::smb;
use crate::zipfile;

const MAX_CHUNK: u64 = 8 * 1024 * 1024;

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        "read4ever-stream",
        |ctx, request, responder| {
            // 读盘（本地/SMB/zip）放后台线程，避免阻塞事件循环。
            // 但 respond 必须回主线程执行：WKURLSchemeTask 的 did* 调用与 WebKit 的
            // stopURLSchemeTask 都发生在主线程，后台线程直接调 did* 会在任务刚被
            // 停止时（seek 拖尾时 WebKit 批量取消在途请求）抛 NSException
            // （"This task has already been stopped"）；panic="abort" 构建下 objc2
            // 的 @try 拦不住它，异常展开直接 abort。回主线程后 respond 与 stop
            // 串行化：stop 在前则 wry 校验跳过 did*，stop 在后则任务仍有效。
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let response = serve(request);
                // 应用退出中派发失败：丢弃响应即可（任务随后随窗口一起取消）
                let _ = app.run_on_main_thread(move || {
                    responder.respond(response);
                });
            });
        },
    )
}

/* ========== 请求处理 ========== */

pub fn serve(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = request.uri().path();
    let decoded = percent_decode_str(raw.strip_prefix('/').unwrap_or(raw))
        .decode_utf8_lossy()
        .to_string();
    let target = decoded.trim();
    if target.is_empty() {
        return err_response(StatusCode::NOT_FOUND, "缺少目标路径");
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // SMB 分支在最前：远程 zip 复合目标协议不支持，显式拒绝（前端不会生成该 URL，纯防御）
    if smb::is_smb_path(target) {
        if target.contains("::") {
            return err_response(StatusCode::NOT_FOUND, "远程 zip 内的视频不支持流式播放");
        }
        return serve_smb(target, range.as_deref());
    }

    if let Some((zip, entry)) = split_zip_target(target) {
        return serve_zip(zip, entry, range.as_deref());
    }
    serve_file(target, range.as_deref())
}

/// zip 复合路径拆分（从右往左找「::」，左侧需以 .zip 结尾——与前端组合路径语义一致）
fn split_zip_target(target: &str) -> Option<(&str, &str)> {
    let mut end = target.len();
    while let Some(i) = target[..end].rfind("::") {
        let left = &target[..i];
        if left.to_ascii_lowercase().ends_with(".zip") {
            return Some((left, &target[i + 2..]));
        }
        if i == 0 {
            break;
        }
        end = i;
    }
    None
}

fn serve_file(path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let meta = match fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => return err_response(StatusCode::NOT_FOUND, format!("文件不存在: {}", path)),
    };
    let total = meta.len();
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(e) => return err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("打开失败: {}", e)),
    };
    let (s, e) = match parse_range(range.as_deref(), total) {
        Err(()) => return err_416(total),
        Ok(None) => (0, total.saturating_sub(1).min(MAX_CHUNK - 1)),
        Ok(Some((s, e))) => (s, e.min(s + MAX_CHUNK - 1)),
    };
    read_into_response(&mut f, s, e, total, content_type(path))
}

fn serve_zip(zip: &str, entry: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let total = match tauri::async_runtime::block_on(zipfile::zip_entry_stored_size(zip, entry)) {
        Ok(t) => t,
        Err(e) => return err_response(StatusCode::NOT_FOUND, e),
    };
    let (s, e) = match parse_range(range, total) {
        Err(()) => return err_416(total),
        Ok(None) => (0, total.saturating_sub(1).min(MAX_CHUNK - 1)),
        Ok(Some((s, e))) => (s, e.min(s + MAX_CHUNK - 1)),
    };
    let len = e - s + 1;
    match tauri::async_runtime::block_on(zipfile::read_zip_entry_stored_range(zip, entry, s, len)) {
        Ok(buf) => partial(buf, s, e, total, content_type(entry)),
        Err(err) => err_response(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

/* SMB 普通文件：句柄跨请求常驻（smb 侧播放槽缓存），total 取打开时 size，
   命中零往返；数据读走 smb::stream_read（并发分块 + 块间预取，断线淘汰重开自愈） */
fn serve_smb(path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let total = match tauri::async_runtime::block_on(smb::stream_meta(path)) {
        Ok(t) => t,
        Err(e) => return err_response(StatusCode::NOT_FOUND, e),
    };
    if total == 0 {
        return err_response(StatusCode::NOT_FOUND, "远程文件为空");
    }
    let (s, e) = match parse_range(range, total) {
        Err(()) => return err_416(total),
        Ok(None) => (0, total.saturating_sub(1).min(MAX_CHUNK - 1)),
        Ok(Some((s, e))) => (s, e.min(s + MAX_CHUNK - 1)),
    };
    match tauri::async_runtime::block_on(smb::stream_read(path, s, e - s + 1)) {
        Ok((buf, t)) if !buf.is_empty() => {
            let end = s + buf.len() as u64 - 1;
            partial(buf, s, end, t, content_type(path))
        }
        Ok((_, t)) => err_416(t), // 文件在 meta 与读取间变小，区间已不成立
        Err(err) => err_response(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

fn read_into_response(f: &mut File, s: u64, e: u64, total: u64, ctype: &str) -> Response<Vec<u8>> {
    let take = (e - s + 1) as usize;
    let mut buf = vec![0u8; take];
    let ok = f
        .seek(SeekFrom::Start(s))
        .and_then(|_| f.read_exact(&mut buf))
        .is_ok();
    if !ok {
        return err_response(StatusCode::INTERNAL_SERVER_ERROR, "读取失败");
    }
    partial(buf, s, e, total, ctype)
}

/* ========== Range 语义 ========== */

/// Range 头解析（bytes 单元，取第一个区间）。
/// Ok(None) = 无 Range 头；Err = 无法满足（416）；Ok(Some((s, e))) = 闭区间（未封顶）。
fn parse_range(header_val: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(h) = header_val else {
        return Ok(None);
    };
    let spec = h.trim().strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().ok_or(())?.trim();
    if let Some(suffix) = first.strip_prefix('-') {
        let n: u64 = suffix.trim().parse().map_err(|_| ())?;
        if n == 0 || total == 0 {
            return Err(());
        }
        return Ok(Some((total.saturating_sub(n), total - 1)));
    }
    let (a, b) = first.split_once('-').ok_or(())?;
    let s: u64 = a.trim().parse().map_err(|_| ())?;
    if total == 0 || s >= total {
        return Err(());
    }
    let e = match b.trim().parse::<u64>() {
        Ok(v) if v >= s => v.min(total - 1),
        Ok(_) => return Err(()),
        Err(_) => total - 1,
    };
    Ok(Some((s, e)))
}

fn partial(body: Vec<u8>, s: u64, e: u64, total: u64, ctype: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", s, e, total))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len())
        .body(body)
        .unwrap()
}

fn err_416(total: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{}", total))
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body("请求区间无法满足".to_string().into_bytes())
        .unwrap()
}

fn err_response(status: StatusCode, msg: impl std::fmt::Display) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.to_string().into_bytes())
        .unwrap()
}

/// 媒体类型的 Content-Type（其余一律 octet-stream，浏览器能嗅探）
pub fn content_type(path: &str) -> &'static str {
    let l = path.to_ascii_lowercase();
    if l.ends_with(".mp4") || l.ends_with(".m4v") {
        "video/mp4"
    } else if l.ends_with(".webm") {
        "video/webm"
    } else if l.ends_with(".mov") {
        "video/quicktime"
    } else if l.ends_with(".ogv") || l.ends_with(".ogg") {
        "video/ogg"
    } else if l.ends_with(".mkv") {
        "video/x-matroska"
    } else if l.ends_with(".mp3") {
        "audio/mpeg"
    } else if l.ends_with(".wav") {
        "audio/wav"
    } else {
        "application/octet-stream"
    }
}

/* ========== 测试 ========== */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn req(uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder().uri(uri);
        if let Some(r) = range {
            b = b.header(header::RANGE, r);
        }
        b.body(Vec::new()).unwrap()
    }

    fn temp_file(name: &str, size: usize) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("read4ever_stream_test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = File::create(&p).unwrap();
        let mut buf = vec![0u8; size];
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        f.write_all(&buf).unwrap();
        p
    }

    fn enc(p: &std::path::Path) -> String {
        percent_encoding::utf8_percent_encode(p.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC)
            .to_string()
    }

    #[test]
    fn full_and_capped_responses() {
        let p = temp_file("a.bin", 3000);
        let url = format!("read4ever-stream://localhost/{}", enc(&p));
        // 无 Range：按 bytes=0- 处理，封顶 8MB（这里 3000B 全量）→ 206
        let r = serve(req(&url, None));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 0-2999/3000");
        assert_eq!(r.body().len(), 3000);

        // bytes=0- 封顶：构造超过 MAX_CHUNK 的文件只回 MAX_CHUNK
        let big = temp_file("big.bin", (MAX_CHUNK as usize) + 100);
        let url = format!("read4ever-stream://localhost/{}", enc(&big));
        let r = serve(req(&url, Some("bytes=0-")));
        assert_eq!(
            r.headers().get(header::CONTENT_RANGE).unwrap().to_str().unwrap(),
            format!("bytes 0-{}/{}", MAX_CHUNK - 1, MAX_CHUNK + 100)
        );
        assert_eq!(r.body().len() as u64, MAX_CHUNK);

        // 中段区间
        let r = serve(req(&url, Some("bytes=100-199")));
        assert_eq!(r.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 100-199/8388708");
        assert_eq!(r.body().len(), 100);

        // 后缀区间 bytes=-50 → 最后 50 字节
        let r = serve(req(&url, Some("bytes=-50")));
        assert_eq!(r.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 8388658-8388707/8388708");

        // 越界 → 416
        let r = serve(req(&url, Some("bytes=99999999-")));
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        // 文件不存在 → 404
        let r = serve(req("read4ever-stream://localhost/%E4%B8%8D%E5%AD%98%E5%9C%A8.bin", Some("bytes=0-")));
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn content_matches_file_bytes() {
        let p = temp_file("b.bin", 1000);
        let url = format!("read4ever-stream://localhost/{}", enc(&p));
        let r = serve(req(&url, Some("bytes=10-19")));
        let raw = fs::read(&p).unwrap();
        assert_eq!(&r.body()[..], &raw[10..20]);
    }

    #[test]
    fn zip_stored_entry_range() {
        // 用 zip crate（dev-dependency）构造存储型 zip，验证复合路径区间读取
        let dir = std::env::temp_dir().join("read4ever_stream_test");
        fs::create_dir_all(&dir).unwrap();
        let zpath = dir.join("video.zip");
        let zf = File::create(&zpath).unwrap();
        let mut w = zip::ZipWriter::new(zf);
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 253) as u8).collect();
        w.start_file("media/v.mp4", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))
            .unwrap();
        w.write_all(&data).unwrap();
        w.finish().unwrap();

        let target = format!("{}::media/v.mp4", zpath.to_str().unwrap());
        let url = format!("read4ever-stream://localhost/{}", enc(std::path::Path::new(&target)));
        let r = serve(req(&url, Some("bytes=100-149")));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "video/mp4");
        assert_eq!(r.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 100-149/5000");
        assert_eq!(&r.body()[..], &data[100..150]);

        // 压缩（deflate）条目 → 拒绝区间读取（404，前端回退整读）
        let zpath2 = dir.join("deflate.zip");
        let zf2 = File::create(&zpath2).unwrap();
        let mut w2 = zip::ZipWriter::new(zf2);
        w2.start_file(
            "c.bin",
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        w2.write_all(b"compressible data data data").unwrap();
        w2.finish().unwrap();
        let target2 = format!("{}::c.bin", zpath2.to_str().unwrap());
        let url2 = format!("read4ever-stream://localhost/{}", enc(std::path::Path::new(&target2)));
        let r2 = serve(req(&url2, Some("bytes=0-1")));
        assert_eq!(r2.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn smb_branch_wiring() {
        // 远程 zip 复合目标：显式拒绝（前端不会生成该 URL，纯防御）
        let target = "smb://sid/share/v.zip::e.mp4";
        let url = format!("read4ever-stream://localhost/{}", enc(std::path::Path::new(target)));
        let r = serve(req(&url, Some("bytes=0-1")));
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert!(String::from_utf8_lossy(r.body()).contains("远程 zip"));

        // 无凭证配置的 smb 路径：resolve 即败 → 404 带中文说明（不触网，确定性）
        let target2 = "smb://nosuchid/share/v.mp4";
        let url2 = format!("read4ever-stream://localhost/{}", enc(std::path::Path::new(target2)));
        let r2 = serve(req(&url2, Some("bytes=0-1")));
        assert_eq!(r2.status(), StatusCode::NOT_FOUND);
        assert!(String::from_utf8_lossy(r2.body()).contains("SMB"));
    }
}
