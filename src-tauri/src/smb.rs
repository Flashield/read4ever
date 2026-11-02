/* SMB 远程浏览（smb2 crate，纯 Rust，tokio 异步）。
   spike 结论（2026-10-26，smb2 0.35 源码核实）：
   - 纯 Rust 无 FFI：依赖树已隔离验证 aarch64-apple-ios-sim 目标编译通过（iOS 方案门禁）；
     主工程 iOS 交叉检查卡在 objc2（Tauri iOS 栈需 Xcode），与 smb2 无关
   - 访客登录 = username 留空（或 "Guest"）；消费侧路径分隔符一律 "/"，
     名字里的 Windows 非法字符由 crate 自动做私有区映射
   - 目录条目自带 size/is_directory/modified（FileTime::to_system_time 换算）
   - 区间读：client.open_file_reader(&tree, path) → FileReader::read_at(&self, off, len)
   - ⚠️ 重连语义（0.35 源码核实，2026-10-27 修正）：auto_reconnect 只是给 Connection
     装 reviver；真正“断线重拨+重认证+换新 tree id+重放一次”只发生在 SmbClient
     便捷方法（list_directory/stat/read_file…，内部 replaying 包装器）里，对
     Disconnected/ServerUnresponsive/HandleInvalidated 三类错误生效。直接调
     Tree 层方法（自管 Connection）永远不重连——空闲被 NAS/防火墙断开后全部报错。
     因此本模块所有树操作一律走 client 便捷方法；FileReader 跨会话必失效
     （HandleInvalidated），长读循环里失败要经 stat 触发重连后重开句柄续读。
   规范路径：smb://<服务器id>/<share>/<相对路径>，zip 条目再追加 "::条目名"。
   凭证表由前端启动/增删后经 smb_put_servers 推入（避免读到防抖 save_store 的旧数据）。
   远程写操作（2026-10-29 起反转只读 spike 决定）：delete/rename/mkdir 走 client
   便捷方法。注意：与读路径不同，写操作断线不重放（防双写）——报错由 evict_session
   摘除会话，本次操作需重试，下次操作自动重建；删除为永久操作，无回收站。 */

use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use smb2::pack::FileTime;
use smb2::{ClientConfig, SmbClient, Tree};

use crate::store::SmbServer;

/// 单个网络操作的总超时（连接建立另有 ClientConfig.timeout）
const OP_TIMEOUT: Duration = Duration::from_secs(15);
/// 流式下载的块大小
const CHUNK: u64 = 256 * 1024;
/// read_all 整读上限：超过则拒绝（大文件正道是流式播放/缓存到本地）
const READ_ALL_MAX: u64 = 1024 * 1024 * 1024;

/// 单服务器会话。client+tree 放在同一把异步锁里：client 的便捷方法（断线重连
/// 重放要求 &mut client 与 &mut tree，重连后把新 tree id 原地写回 tree）。
/// 短操作（列目录/stat/打开句柄）持锁执行；返回的 FileReader 是 'static 的，
/// 区间读在锁外并行进行。会话死了不换对象——下一次持锁操作原地复活，
/// 并发等待者拿到的是已复活的连接。
/// cfg 是建会话时的配置快照——put_servers 时与当前表比对，不一致即失效重建。
struct SmbSession {
    cfg: SmbServer,
    core: tokio::sync::Mutex<SmbCore>,
}

struct SmbCore {
    client: SmbClient,
    tree: Tree,
}

/// 服务器凭证表（前端推入）
fn registry() -> &'static RwLock<Vec<SmbServer>> {
    static REG: OnceLock<RwLock<Vec<SmbServer>>> = OnceLock::new();
    REG.get_or_init(|| RwLock::new(Vec::new()))
}

/// 已建立的会话（服务器 id → 会话）
fn sessions() -> &'static RwLock<HashMap<String, Arc<SmbSession>>> {
    static SES: OnceLock<RwLock<HashMap<String, Arc<SmbSession>>>> = OnceLock::new();
    SES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn is_smb_path(p: &str) -> bool {
    p.starts_with("smb://")
}

/// 规范路径 → (配置, share 内相对路径)。share 根（无相对路径）返回空串。
/// smb://a1b2                → share 根
/// smb://a1b2/books/小说/x.txt → "小说/x.txt"（books 段必须与配置的 share 一致）
fn resolve(path: &str) -> Result<(Arc<SmbServer>, String), String> {
    let rest = path
        .strip_prefix("smb://")
        .ok_or_else(|| format!("不是 SMB 路径: {}", path))?;
    let rest = rest.split("::").next().unwrap_or(rest); // 剥掉 zip::条目 复合后缀
    let mut segs = rest.split('/').filter(|s| !s.is_empty());
    let id = segs.next().ok_or("SMB 路径缺少服务器 id")?;
    let cfg = {
        let reg = registry().read().unwrap();
        reg.iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("找不到 SMB 服务器配置（id={}），可能已被删除", id))?
    };
    let mut rel: String = segs.next().unwrap_or("").to_string();
    for seg in segs {
        rel.push('/');
        rel.push_str(seg);
    }
    // 第一段是共享名：与配置不符说明配置改过共享，旧历史路径作废
    if !rel.is_empty() {
        let (share, tail) = match rel.split_once('/') {
            Some((s, t)) => (s, t),
            None => (rel.as_str(), ""),
        };
        if !share.eq_ignore_ascii_case(&cfg.share) {
            return Err(format!(
                "服务器「{}」的共享已改为 {}，旧路径 {} 不再有效",
                cfg.name, cfg.share, share
            ));
        }
        rel = tail.to_string();
    }
    Ok((Arc::new(cfg), rel))
}

/// 主机地址补默认端口
fn addr_of(cfg: &SmbServer) -> String {
    if cfg.host.contains(':') {
        cfg.host.clone()
    } else {
        format!("{}:445", cfg.host)
    }
}

fn config_of(cfg: &SmbServer) -> ClientConfig {
    ClientConfig {
        addr: addr_of(cfg),
        timeout: Duration::from_secs(8),
        username: cfg.username.clone(),
        password: cfg.password.clone(),
        domain: cfg.workgroup.clone(),
        auto_reconnect: true,
        ..Default::default()
    }
}

/// 建立（或复用）服务器会话
async fn session_for(id: &str) -> Result<Arc<SmbSession>, String> {
    {
        let ses = sessions().read().unwrap();
        if let Some(s) = ses.get(id) {
            return Ok(s.clone());
        }
    }
    let cfg = {
        let reg = registry().read().unwrap();
        reg.iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("找不到 SMB 服务器配置（id={}）", id))?
    };
    let mut client = SmbClient::connect(config_of(&cfg))
        .await
        .map_err(|e| format!("连接 {} 失败: {}", addr_of(&cfg), e))?;
    let tree = client
        .connect_share(&cfg.share)
        .await
        .map_err(|e| format!("连接共享 \\\\{}\\{} 失败: {}", cfg.host, cfg.share, e))?;
    let session = Arc::new(SmbSession {
        cfg,
        core: tokio::sync::Mutex::new(SmbCore { client, tree }),
    });
    sessions()
        .write()
        .unwrap()
        .insert(id.to_string(), session.clone());
    Ok(session)
}

/// 前端推入服务器表；配置已变化或已删除的会话随之失效（下次访问按新表重建）
pub fn put_servers(servers: Vec<SmbServer>) {
    {
        let mut reg = registry().write().unwrap();
        *reg = servers;
    }
    let reg = registry().read().unwrap();
    sessions()
        .write()
        .unwrap()
        .retain(|_id, s| reg.iter().any(|cur| cur == &s.cfg));
}

/// 测试连接：连服务器 + 连共享 + 列共享根，全通才返回成功
pub async fn test_connection(cfg: &SmbServer) -> Result<String, String> {
    let addr = addr_of(cfg);
    let fut = async {
        let mut client = SmbClient::connect(config_of(cfg))
            .await
            .map_err(|e| format!("无法连接 {}: {}", addr, e))?;
        let mut tree = client
            .connect_share(&cfg.share)
            .await
            .map_err(|e| format!("无法打开共享 \\\\{}\\{}: {}", cfg.host, cfg.share, e))?;
        let entries = client
            .list_directory(&mut tree, "")
            .await
            .map_err(|e| format!("无法读取共享根目录: {}", e))?;
        Ok::<_, String>(format!("{}（{} 个条目）", addr, entries.len()))
    };
    // 交互场景包总超时：TCP 连接 8s + 每请求 30s 响应超时，正常情况远快于 15s
    match tokio::time::timeout(Duration::from_secs(15), fut).await {
        Ok(r) => r,
        Err(_) => Err("连接超时（15 秒无响应）".into()),
    }
}

/* ========== 目录浏览 ========== */

/// 远程目录条目：本地 FileEntry 之上多一个 cached 标记（serde flatten，前端字段同形）
#[derive(Serialize, Clone)]
pub struct SmbFileEntry {
    #[serde(flatten)]
    pub entry: crate::commands::FileEntry,
    pub cached: bool, // 本地缓存存在且新鲜
}

fn mtime_ms(t: FileTime) -> u64 {
    t.to_system_time()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 网络操作统一包总超时（内层 Result 原样透出，由调用方映射错误文案）
async fn with_timeout<F: std::future::Future>(what: &str, f: F) -> Result<F::Output, String> {
    match tokio::time::timeout(OP_TIMEOUT, f).await {
        Ok(inner) => Ok(inner),
        Err(_) => Err(format!("{}超时（15 秒无响应）", what)),
    }
}

/// 连接类错误（会话已死/复活失败）：把会话从缓存表摘除，下次访问按全新连接重建。
/// 不摘除的话，smb2 对复活失败的连接有 10s 冷却期——期间即使服务器已恢复，
/// 同一连接也直接返回冷却前的旧错误；重建连接绕开冷却期。
fn evict_session(id: &str, e: &smb2::Error) {
    let dead = matches!(
        e,
        smb2::Error::Disconnected
            | smb2::Error::ServerUnresponsive { .. }
            | smb2::Error::ReconnectFailed { .. }
            | smb2::Error::HandleInvalidated { .. }
    );
    if dead {
        sessions().write().unwrap().remove(id);
    }
}

/// 列出 share 内单层目录（smb://…/share[/子路径]）：目录优先，跳 . .. 隐藏项。
/// natural=true 名称自然排序，false 名称不区分大小写典序排序
pub async fn list_dir(path: &str, cache_dir: &Path, natural: bool) -> Result<Vec<SmbFileEntry>, String> {
    let (cfg, rel) = resolve(path)?;
    let ses = session_for(&cfg.id).await?;
    // list_directory 的目录参数带尾斜杠（share 根传空串）
    let list_path = if rel.is_empty() {
        String::new()
    } else {
        format!("{}/", rel)
    };
    // client 便捷方法：空闲断线时自动重连重认证+重放一次（tree 层方法不重连）
    let entries = {
        let mut core = ses.core.lock().await;
        let SmbCore { client, tree } = &mut *core;
        match with_timeout("列目录", client.list_directory(tree, &list_path)).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                evict_session(&cfg.id, &e);
                return Err(format!("无法读取远程目录 {}: {}", path, e));
            }
            Err(msg) => return Err(msg),
        }
    };
    // 子条目路径要含共享名段：列 share 根时入参可能是别名 smb://<id>（无共享段），
    // 补成 smb://<id>/<share> 才是规范路径，后续 resolve/打开/缓存才能通过共享名校验
    let parent = if rel.is_empty() {
        format!("smb://{}/{}", cfg.id, cfg.share)
    } else {
        path.split("::").next().unwrap_or(path).trim_end_matches('/').to_string()
    };
    let mut out: Vec<SmbFileEntry> = Vec::new();
    for e in entries {
        if e.name == "." || e.name == ".." || e.name.starts_with('.') || e.attributes.is_hidden() {
            continue;
        }
        let child_path = format!("{}/{}", parent, e.name);
        let mtime = mtime_ms(e.modified);
        // 新鲜判定用本次列表自带的 size/mtime，不再逐条远程 stat
        let cached =
            !e.is_directory && fresh_meta(cache_dir, &child_path, e.size, mtime);
        out.push(SmbFileEntry {
            entry: crate::commands::FileEntry {
                name: e.name,
                path: child_path,
                is_dir: e.is_directory,
                size: if e.is_directory { 0 } else { e.size },
                mtime,
            },
            cached,
        });
    }
    out.sort_by(|a, b| match (b.entry.is_dir, a.entry.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => {
            if natural {
                crate::natural::natural_cmp(&a.entry.name, &b.entry.name)
            } else {
                a.entry.name.to_lowercase().cmp(&b.entry.name.to_lowercase())
            }
        }
    });
    Ok(out)
}

/// 远程 stat：(大小, mtime 毫秒, 是否目录)
pub async fn stat(path: &str) -> Result<(u64, u64, bool), String> {
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Ok((0, 0, true)); // share 根视作目录
    }
    let ses = session_for(&cfg.id).await?;
    let info = {
        let mut core = ses.core.lock().await;
        let SmbCore { client, tree } = &mut *core;
        match with_timeout("访问远程文件", client.stat(tree, &rel)).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                evict_session(&cfg.id, &e);
                return Err(format!("无法访问 {}: {}", path, e));
            }
            Err(msg) => return Err(msg),
        }
    };
    Ok((info.size, mtime_ms(info.modified), info.is_directory))
}

/* ========== 本地缓存（app_cache_dir/smb/） ========== */

#[derive(Serialize)]
pub struct SmbCacheStatus {
    pub cached: bool, // 本地副本存在（哪怕过期）
    pub fresh: bool,  // 与远程 size+mtime 一致
    pub bytes: u64,   // 本地副本字节数
}

#[derive(Serialize, Deserialize)]
struct CacheMeta {
    size: u64,
    mtime_ms: u64,
}

/// 规范路径 → 稳定缓存键（FNV-1a 64，确定性哈希，跨版本/跨平台一致）
fn key_of(path: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", h)
}

fn meta_of(cache_dir: &Path, path: &str) -> Option<CacheMeta> {
    let f = std::fs::read(cache_dir.join(format!("{}.json", key_of(path)))).ok()?;
    serde_json::from_slice(&f).ok()
}

/// 本地缓存是否与远程 (size, mtime) 一致
fn fresh_meta(cache_dir: &Path, path: &str, size: u64, mtime: u64) -> bool {
    meta_of(cache_dir, path).is_some_and(|m| m.size == size && m.mtime_ms == mtime)
}

/// 单块远程读取（超时与错误统一折算成中文文案）
async fn read_chunk(
    reader: &mut smb2::client::stream::FileReader,
    off: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    with_timeout("下载数据", reader.read_at(off, len))
        .await?
        .map_err(|e| e.to_string())
}

/// 缓存远程文件：已新鲜直接复用；否则 256KB 块流式下载，.part → rename 原子落盘
pub async fn cache_file(path: &str, cache_dir: &Path) -> Result<PathBuf, String> {
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("共享根目录无需缓存".into());
    }
    let ses = session_for(&cfg.id).await?;
    let info = {
        let mut core = ses.core.lock().await;
        let SmbCore { client, tree } = &mut *core;
        match with_timeout("访问远程文件", client.stat(tree, &rel)).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                evict_session(&cfg.id, &e);
                return Err(format!("无法访问 {}: {}", path, e));
            }
            Err(msg) => return Err(msg),
        }
    };
    if info.is_directory {
        return Err("目录无需缓存".into());
    }
    let (size, mtime) = (info.size, mtime_ms(info.modified));
    let key = key_of(path);
    let bin = cache_dir.join(format!("{}.bin", key));
    if bin.exists() && fresh_meta(cache_dir, path, size, mtime) {
        return Ok(bin); // 已新鲜，免下载
    }
    let (mut reader, _) = open_smb_reader(&ses, &rel, path).await?;
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    let part = cache_dir.join(format!("{}.part", key));
    let mut out = std::fs::File::create(&part).map_err(|e| format!("写缓存失败: {}", e))?;
    let mut off = 0u64;
    while off < size {
        let len = CHUNK.min(size - off);
        let chunk = match read_chunk(&mut reader, off, len).await {
            Ok(c) => c,
            Err(why) => {
                // 大文件下载中途断线：句柄已随会话失效。经 open_smb_reader 的
                // healing stat 重连后重开句柄，从当前偏移续传（每块至多重试一次）
                reader = match open_smb_reader(&ses, &rel, path).await {
                    Ok((r, _)) => r,
                    Err(reopen_err) => {
                        let _ = std::fs::remove_file(&part);
                        return Err(format!(
                            "下载 {} 失败: {}（重开远程文件失败: {}）",
                            path, why, reopen_err
                        ));
                    }
                };
                match read_chunk(&mut reader, off, len).await {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = std::fs::remove_file(&part);
                        return Err(format!("下载 {} 失败: {}", path, e));
                    }
                }
            }
        };
        if chunk.is_empty() {
            let _ = std::fs::remove_file(&part);
            return Err(format!("下载 {} 失败: 远程提前结束", path));
        }
        out.write_all(&chunk).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("写缓存失败: {}", e)
        })?;
        off += chunk.len() as u64;
    }
    out.flush().map_err(|e| format!("写缓存失败: {}", e))?;
    drop(out);
    std::fs::rename(&part, &bin).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("缓存落盘失败: {}", e)
    })?;
    let meta = CacheMeta { size, mtime_ms: mtime };
    std::fs::write(
        cache_dir.join(format!("{}.json", key)),
        serde_json::to_vec(&meta).map_err(|e| format!("写缓存元数据失败: {}", e))?,
    )
    .map_err(|e| format!("写缓存元数据失败: {}", e))?;
    Ok(bin)
}

/// 查询缓存状态（fresh 需一次远程 stat）
pub async fn cached_status(path: &str, cache_dir: &Path) -> Result<SmbCacheStatus, String> {
    let (size, mtime, _) = stat(path).await?;
    let bin = cache_dir.join(format!("{}.bin", key_of(path)));
    let cached = bin.exists() && meta_of(cache_dir, path).is_some();
    let bytes = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
    Ok(SmbCacheStatus {
        cached,
        fresh: cached && fresh_meta(cache_dir, path, size, mtime),
        bytes,
    })
}

/// 清空全部本地缓存，返回释放的字节数
pub fn clear_cache(cache_dir: &Path) -> Result<u64, String> {
    let mut freed = 0u64;
    if !cache_dir.exists() {
        return Ok(0);
    }
    let rd = std::fs::read_dir(cache_dir).map_err(|e| format!("读取缓存目录失败: {}", e))?;
    for item in rd.flatten() {
        let p = item.path();
        let wanted = p
            .extension()
            .is_some_and(|x| x == "bin" || x == "json" || x == "part");
        if !wanted {
            continue;
        }
        if let Ok(md) = item.metadata() {
            freed += md.len();
        }
        std::fs::remove_file(&p).map_err(|e| format!("删除缓存失败: {}", e))?;
    }
    Ok(freed)
}

/* ========== 远程文件打开 ========== */

/// 整文件网络读取（文本打开、插件原始字节用；大文件较慢，超时放宽到 60s）。
/// 读循环在会话锁外进行（FileReader 是 'static 的）；断线时句柄随会话失效，
/// 经 open_smb_reader 的 healing stat 重连后重开句柄整读重试一次。
pub async fn read_all(path: &str) -> Result<Vec<u8>, String> {
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("共享根不是文件".into());
    }
    let ses = session_for(&cfg.id).await?;
    let (reader, _) = open_smb_reader(&ses, &rel, path).await?;
    let size = reader.size();
    if size == 0 {
        return Ok(Vec::new());
    }
    if size > READ_ALL_MAX {
        return Err("远程文件过大（上限 1 GB），不支持整读——请用流式播放或先缓存到本地".into());
    }
    let first = tokio::time::timeout(Duration::from_secs(60), reader.read_at(0, size)).await;
    let data = match first {
        Ok(Ok(data)) => data,
        Ok(Err(_)) | Err(_) => {
            let (reader, _) = open_smb_reader(&ses, &rel, path).await?;
            tokio::time::timeout(Duration::from_secs(60), reader.read_at(0, size))
                .await
                .map_err(|_| "下载数据超时（60 秒）".to_string())?
                .map_err(|e| format!("读取 {} 失败: {}", path, e))?
        }
    };
    Ok(data)
}

fn file_content_of(
    path: &str,
    content: String,
    encoding: String,
    note: Option<&str>,
) -> crate::commands::FileContent {
    let pure = path.split("::").next().unwrap_or(path);
    let file_name = pure.rsplit('/').next().unwrap_or(pure).to_string();
    let hard = crate::reorder::looks_like_hard_lines(&content);
    crate::commands::FileContent {
        content,
        encoding,
        file_name,
        file_path: path.to_string(),
        is_hard_lines: hard,
        note: note.map(|s| s.to_string()),
    }
}

/// 打开本地缓存副本（复用本地编码检测管线）
fn local_open(
    bin: &Path,
    path: &str,
    forced: Option<&str>,
    note: Option<&str>,
) -> Result<crate::commands::FileContent, String> {
    let (content, enc) =
        crate::zipfile::read_text_file(&bin.to_string_lossy(), forced)
            .map_err(|e| format!("读取本地缓存失败: {}", e))?;
    Ok(file_content_of(path, content, enc, note))
}

/// 打开远程文本：新鲜缓存 → 网络整读 → 网络失败用旧缓存兜底。
/// filePath 回填原 smb:// 路径，历史/书架的键保持规范。
pub async fn open_text(
    path: &str,
    cache_dir: &Path,
    forced_encoding: Option<&str>,
) -> Result<crate::commands::FileContent, String> {
    let bin = cache_dir.join(format!("{}.bin", key_of(path)));
    let fresh = match stat(path).await {
        Ok((size, mtime, is_dir)) => {
            if is_dir {
                return Err("这是远程目录，不是文件".into());
            }
            bin.exists() && fresh_meta(cache_dir, path, size, mtime)
        }
        Err(e) => {
            // 断网等场景：有旧缓存就兜底，否则原样报错
            if !bin.exists() {
                return Err(e);
            }
            return local_open(
                &bin,
                path,
                forced_encoding,
                Some("无法访问远程服务器，已用本地缓存打开（内容可能不是最新）"),
            );
        }
    };
    if fresh {
        return local_open(&bin, path, forced_encoding, None);
    }
    match read_all(path).await {
        Ok(bytes) => {
            let (content, enc) = if let Some(f) = forced_encoding {
                crate::encoding::decode_with(&bytes, f)?
            } else {
                let (t, e) = crate::encoding::detect_and_decode(&bytes);
                (t, e.to_string())
            };
            Ok(file_content_of(path, content, enc, None))
        }
        Err(e) => {
            if bin.exists() {
                local_open(
                    &bin,
                    path,
                    forced_encoding,
                    Some("网络读取失败，已用本地缓存打开（内容可能不是最新）"),
                )
            } else {
                Err(e)
            }
        }
    }
}

/* ========== 流式播放（句柄常驻 + 并发分块读 + 块间预取） ==========
   弱网（高 RTT）下逐块慢的三个根因与对策：
   1. FileReader::read_at 内部是串行循环（一次一个在途 SMB READ）——本层把
      大区间拆成 512KB 子读、STREAM_PARALLEL 路并发在途（FileReader 文档保证
      read_at 可并发调用），把 RTT 藏进流水线（crate 自测 +60ms RTT 下
      8 路在途比串行快 6.5 倍）；
   2. 每个播放块请求都 stat+stat+CREATE 三个往返——句柄跨请求常驻
      （STREAM_SLOTS 个 LRU 槽），命中后零往返；会话重连后句柄失效，
      读取失败即淘汰重开重试一次（对齐 SmbReader 的自愈语义）；
   3. 播放器收完一块才请求下一块，块间线路空闲——每块读毕即后台预取下一
      STREAM_PREFETCH 字节，下一请求直接命中内存（Web 套层 MAX_CHUNK 与本值
      对齐，顺序播放时预取块边界与请求边界天然重合；seek 到别处则整块作废）；
   4. WebKit 解析 mp4 索引（moov 常在文件尾）时发 4–100B 微读，且与顺序播放流
      交错——微读若等在途预取/触发布防大块，8 字节读要付一整块 8MB（线上日志
      实测平均每微读 5MB，播放一帧一帧爬）。对策：小于 STREAM_SMALL 的请求
      直接网络读 + 只布防小块；Ready 块常驻复用（不再整块丢弃），大请求仅在
      顺序推进越过块尾时布防下一大块。 */

/// 单个子读的目标大小（对齐 crate DOWNLOAD_CHUNK_SIZE：512KB×8 路已拿下
/// 快链路 90-100% 收益，再大只会让慢链路上的其他请求排队更久）
const STREAM_SUB: u64 = 512 * 1024;
/// 最大并发在途子读数（对齐 crate ADAPTIVE_MAX_IN_FLIGHT 的 4MiB 在途量）
const STREAM_PARALLEL: usize = 8;
/// 预取块大小（与 stream 层 MAX_CHUNK 对齐：8MB）
const STREAM_PREFETCH: u64 = 8 * 1024 * 1024;
/// 句柄缓存容量（LRU；每路视频一个槽，音视频同时播也够用）
const STREAM_SLOTS: usize = 4;
/// 小于此长度的请求按元数据/扫描访问处理（WebKit 解析 mp4 moov 索引时发 4–100B
/// 微读）：不等在途预取、不布防大块，直接网络读——否则 8 字节读要等/拉整块 8MB
const STREAM_SMALL: u64 = 256 * 1024;
/// 微读的小块预取量（吸收索引表的连续小步进；只在空位/换小块时布防）
const STREAM_SMALL_PF: u64 = 256 * 1024;
/// 预取任务自身超时：裸 read_at 在弱网下可能无限挂起，超时放弃落 Empty
/// （挂起的 Running 会占住状态位，微读布防全被「在途不打断」拒绝——
/// 线上实测整窗零预取命中、每笔微读付整往返）
const STREAM_PF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 在途超龄：超过此时长未落盘视为挂起，微读布防可换下重启
const STREAM_RUNNING_STALE: std::time::Duration = std::time::Duration::from_secs(4);

/// 诊断：流式路径累计网络读取字节数（含预取任务；微读不应触发兆级下载）
static NET_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
fn net_bytes_for_test() -> u64 {
    NET_BYTES.load(std::sync::atomic::Ordering::Relaxed)
}

/// 把 [offset, offset+len) 按 sub 拆成子读区间（越界截断到 total；
/// offset 越界或 len 为 0 返回空）
fn plan_sub_reads(offset: u64, len: u64, total: u64, sub: u64) -> Vec<(u64, u64)> {
    if len == 0 || offset >= total {
        return Vec::new();
    }
    let take = len.min(total - offset);
    let end = offset + take;
    let mut subs = Vec::with_capacity((take.div_ceil(sub)) as usize);
    let mut pos = offset;
    while pos < end {
        let l = (end - pos).min(sub);
        subs.push((pos, l));
        pos += l;
    }
    subs
}

/// 预取块 [start, start+p_len) 是否完整覆盖请求 [off, off+len)。
/// 只认全盖：部分重叠宁可重读（至多浪费一块，避免边界拼接的复杂度）
fn prefetch_hit(start: u64, p_len: u64, off: u64, len: u64) -> bool {
    off >= start && off + len <= start + p_len
}

/// 单个远程文件播放槽：句柄 + 预取块。会话死后句柄原地重开复活。
struct StreamSlot {
    ses: Arc<SmbSession>,
    cfg: Arc<SmbServer>, // 建槽时配置快照：put_servers 后比对，变了即作废重建
    rel: String,
    path: String, // 仅错误文案
    handle: tokio::sync::Mutex<Option<Arc<smb2::client::stream::FileReader>>>,
    prefetch: tokio::sync::Mutex<Prefetch>,
}

/// 预取块状态。Running 持后台任务句柄：请求命中在途预取时等它（不重复占线），
/// arm 新预取时 abort 旧任务（放弃播放器已 seek 走的区域）。
enum Prefetch {
    Empty,
    Running {
        start: u64,
        len: u64,
        armed_at: std::time::Instant, // 超龄判定：微读布防可换下挂起的在途
        join: tauri::async_runtime::JoinHandle<Prefetched>,
    },
    Ready {
        start: u64,
        data: Arc<Vec<u8>>,
    },
}

/// 预取任务产物：None = 读取失败（网络抖动等），等待方据此落到网络读
struct Prefetched {
    data: Option<Arc<Vec<u8>>>,
}

fn slot_store(
) -> &'static std::sync::Mutex<HashMap<String, (Arc<StreamSlot>, std::time::Instant)>> {
    static S: OnceLock<std::sync::Mutex<HashMap<String, (Arc<StreamSlot>, std::time::Instant)>>> =
        OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 取（或建）播放槽：配置变化（put_servers 后 cfg 不同）作废重建，容量满淘汰最久未用
async fn stream_slot(cfg: &Arc<SmbServer>, rel: &str, path: &str) -> Result<Arc<StreamSlot>, String> {
    let ses = session_for(&cfg.id).await?;
    let mut store = slot_store().lock().unwrap();
    if let Some((slot, last)) = store.get_mut(path) {
        if slot.cfg == *cfg {
            *last = std::time::Instant::now();
            return Ok(slot.clone());
        }
        store.remove(path); // 配置已改：旧句柄随旧会话作废
    }
    if store.len() >= STREAM_SLOTS {
        if let Some(oldest) = store
            .iter()
            .min_by_key(|(_, (_, t))| *t)
            .map(|(k, _)| k.clone())
        {
            store.remove(&oldest);
        }
    }
    let slot = Arc::new(StreamSlot {
        ses,
        cfg: cfg.clone(),
        rel: rel.to_string(),
        path: path.to_string(),
        handle: tokio::sync::Mutex::new(None),
        prefetch: tokio::sync::Mutex::new(Prefetch::Empty),
    });
    store.insert(path.to_string(), (slot.clone(), std::time::Instant::now()));
    Ok(slot)
}

/// 摘除播放槽（重开仍失败时）：槽持有旧会话 Arc，不摘会绕开 evict_session
/// 「重建连接绕开 smb2 复活冷却期」的机制，下次访问一直撞死会话
fn drop_slot(path: &str) {
    slot_store().lock().unwrap().remove(path);
}

/// 确保槽内句柄打开：命中即零网络往返；未命中 stat+CREATE 一次（含目录拦截）
async fn ensure_handle(
    slot: &Arc<StreamSlot>,
) -> Result<(Arc<smb2::client::stream::FileReader>, u64), String> {
    let mut g = slot.handle.lock().await;
    if let Some(r) = g.as_ref() {
        return Ok((r.clone(), r.size()));
    }
    let t0 = std::time::Instant::now();
    let (reader, _) = open_smb_reader(&slot.ses, &slot.rel, &slot.path).await?;
    eprintln!(
        "[smb] {} 打开句柄 {} 用时{:?}",
        crate::stream::ts(),
        slot.path.rsplit('/').next().unwrap_or(&slot.path),
        t0.elapsed()
    );
    let total = reader.size();
    let r = Arc::new(reader);
    *g = Some(r.clone());
    Ok((r, total))
}

/// 淘汰槽内句柄（读取失败后强制重开用；在途请求手里的旧 Arc 自行失效）
async fn invalidate_handle(slot: &Arc<StreamSlot>) {
    *slot.handle.lock().await = None;
}

/// 并发分块读 [offset, offset+len)：512KB 子读、STREAM_PARALLEL 路在途，
/// 按偏移重组。len 需已按 total 截断（调用方负责）
async fn read_pipelined(
    reader: &Arc<smb2::client::stream::FileReader>,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    let subs = plan_sub_reads(offset, len, reader.size(), STREAM_SUB);
    if subs.is_empty() {
        return Ok(Vec::new());
    }
    NET_BYTES.fetch_add(len, std::sync::atomic::Ordering::Relaxed);
    let mut out = vec![0u8; len as usize];
    let mut js = tokio::task::JoinSet::new();
    let mut queue: std::collections::VecDeque<(u64, u64)> = subs.into();
    // 填满窗口后每完成一个补一个：线路始终保持满在途
    while js.len() < STREAM_PARALLEL {
        if let Some((o, l)) = queue.pop_front() {
            let r = reader.clone();
            js.spawn(async move { (o, l, r.read_at(o, l).await) });
        } else {
            break;
        }
    }
    while let Some(joined) = js.join_next().await {
        let (o, l, res) = joined.map_err(|e| format!("并发子读失败: {}", e))?;
        let data = res.map_err(|e| e.to_string())?;
        if data.len() as u64 != l {
            return Err(format!("远程读取不足: 请求 {} 字节，得到 {}", l, data.len()));
        }
        let at = (o - offset) as usize;
        out[at..at + data.len()].copy_from_slice(&data);
        if let Some((o, l)) = queue.pop_front() {
            let r = reader.clone();
            js.spawn(async move { (o, l, r.read_at(o, l).await) });
        }
    }
    Ok(out)
}

/// 预取布防种类：大块（顺序播放推进）与小块（微读扫描的顺手预取）。
/// 小块会换掉任何陈旧 Ready（请求已挪窝，旧块对活跃流无价值；大请求 Miss
/// 时自会重新布防自愈），但绝不打断在途任务（等它落盘后下一笔再换）
enum ArmKind {
    Big,
    Small,
}

/// 预取 [start, start+len)（后台执行）：已在途/已就绪同区间则跳过，
/// 否则按 kind 决定替换策略。任务完成仅在槽内仍是自己时落盘（被替换/消费则丢弃）
async fn arm_prefetch(
    slot: &Arc<StreamSlot>,
    reader: Arc<smb2::client::stream::FileReader>,
    total: u64,
    start: u64,
    kind: ArmKind,
) {
    if start >= total {
        return;
    }
    let len = match kind {
        ArmKind::Big => STREAM_PREFETCH.min(total - start),
        ArmKind::Small => STREAM_SMALL_PF.min(total - start),
    };
    let mut p = slot.prefetch.lock().await;
    match &*p {
        Prefetch::Ready { start: s, .. } | Prefetch::Running { start: s, .. } if *s == start => {
            return; // 同区间已就绪/已在途
        }
        _ => {}
    }
    let name = slot.path.rsplit('/').next().unwrap_or(&slot.path).to_string();
    match kind {
        ArmKind::Big => {
            if let Prefetch::Running { join, .. } = &mut *p {
                join.abort(); // 播放器已 seek 走：放弃旧区域
            }
        }
        ArmKind::Small => {
            // 在途任务不打断（等它落盘后下一笔再换），但超龄视为挂起必须换下，
            // 否则一个挂死的 Running 会让微读区域永远零预取
            let stale = matches!(&*p, Prefetch::Running { armed_at, .. } if armed_at.elapsed() > STREAM_RUNNING_STALE);
            if !matches!(&*p, Prefetch::Empty | Prefetch::Ready { .. }) && !stale {
                if let Prefetch::Running { start: cur, armed_at, .. } = &*p {
                    eprintln!(
                        "[smb] {} {} 小块布防让位 @{}/{}（在途 @{} 已 {:.1}s）",
                        crate::stream::ts(),
                        name,
                        start,
                        len,
                        cur,
                        armed_at.elapsed().as_secs_f32()
                    );
                }
                return;
            }
            if let Prefetch::Running { join, start: cur, armed_at, .. } = &mut *p {
                eprintln!(
                    "[smb] {} {} 换下超龄在途 @{}（已 {:.1}s）布防 @{}/{}",
                    crate::stream::ts(),
                    name,
                    cur,
                    armed_at.elapsed().as_secs_f32(),
                    start,
                    len
                );
                join.abort();
            }
        }
    }
    let slot2 = slot.clone();
    let r2 = reader.clone();
    let task_name = name.clone();
    let join = tauri::async_runtime::spawn(async move {
        let t0 = std::time::Instant::now();
        let data = match tokio::time::timeout(STREAM_PF_TIMEOUT, read_pipelined(&r2, start, len)).await {
            Ok(Ok(d)) => Some(Arc::new(d)),
            Ok(Err(e)) => {
                eprintln!("[smb] {} {} 预取失败 @{}/{}: {}", crate::stream::ts(), task_name, start, len, e);
                None
            }
            Err(_) => {
                eprintln!(
                    "[smb] {} {} 预取超时(>{:?}) @{}/{}",
                    crate::stream::ts(),
                    task_name,
                    STREAM_PF_TIMEOUT,
                    start,
                    len
                );
                None
            }
        };
        // 槽内仍是自己的 Running 才落盘（被替换/已被消费则只经返回值交给等待方）
        let mut p = slot2.prefetch.lock().await;
        let ours = matches!(&*p, Prefetch::Running { start: s, .. } if *s == start);
        if ours {
            match &data {
                Some(d) => {
                    eprintln!(
                        "[smb] {} {} 预取落盘 @{}/{} 用时{:?}",
                        crate::stream::ts(),
                        task_name,
                        start,
                        d.len(),
                        t0.elapsed()
                    );
                    *p = Prefetch::Ready { start, data: d.clone() };
                }
                None => *p = Prefetch::Empty,
            }
        }
        Prefetched { data }
    });
    eprintln!(
        "[smb] {} {} 布防{} @{}/{}",
        crate::stream::ts(),
        name,
        if matches!(kind, ArmKind::Big) { "大" } else { "小" },
        start,
        len
    );
    *p = Prefetch::Running { start, len, armed_at: std::time::Instant::now(), join };
}

/// 流式播放元信息：文件总长（复用常驻句柄，命中零往返）。目录报错为 NOT_FOUND 文案
pub async fn stream_meta(path: &str) -> Result<u64, String> {
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("共享根不是文件".into());
    }
    let slot = stream_slot(&cfg, &rel, path).await?;
    let (_, total) = ensure_handle(&slot).await?;
    Ok(total)
}

/// 流式播放读（stream 层 serve_smb 用）：返回 (数据, 文件总长)。
/// 顺序：预取命中直接切 → 未命中并发分块读（失败淘汰句柄重开整块重试一次）
/// → 读毕后台预取下一块。整体 60s 超时（对齐原 read_range）。
/// offset 越界返回空数据（调用方折算 416）。
pub async fn stream_read(path: &str, offset: u64, len: u64) -> Result<(Vec<u8>, u64), String> {
    let t0 = std::time::Instant::now();
    let log_serve = |how: &str, off: u64, take: u64| {
        eprintln!(
            "[smb] {} {} {} off={} len={} 用时{:?}",
            crate::stream::ts(),
            path.rsplit('/').next().unwrap_or(path),
            how,
            off,
            take,
            t0.elapsed()
        );
    };
    let fut = async {
        let (cfg, rel) = resolve(path)?;
        if rel.is_empty() {
            return Err("共享根不是文件".into());
        }
        let slot = stream_slot(&cfg, &rel, path).await?;
        let (reader, total) = ensure_handle(&slot).await?;
        if len == 0 || offset >= total {
            return Ok((Vec::new(), total));
        }
        let take = len.min(total - offset);
        // 微读（< STREAM_SMALL，如 WebKit 解析 mp4 moov 索引的 4–100B 请求）：
        // 不等在途预取、不布防大块——8 字节等/拉一整块 8MB 是数量级的反向优化
        let small = take < STREAM_SMALL;
        // ① 预取命中：Ready 直接切（块常驻复用，直到被新布防替换/槽淘汰）
        {
            let mut p = slot.prefetch.lock().await;
            if let Prefetch::Ready { start, data } = &*p {
                if prefetch_hit(*start, data.len() as u64, offset, take) {
                    let from = (offset - *start) as usize;
                    let buf = data[from..from + take as usize].to_vec();
                    let past_end = offset + take >= *start + data.len() as u64;
                    drop(p);
                    log_serve("预取命中", offset, take);
                    // 大请求顺序推进越过块尾才布防下一大块（微读不布防）
                    if !small && past_end {
                        arm_prefetch(&slot, reader, total, offset + take, ArmKind::Big).await;
                    }
                    return Ok((buf, total));
                }
            }
            // 大请求取出命中的在途预取句柄（非命中原样放回）；锁外等待。
            // 微读不等：预取正占用线路，直接并发读自己那几个字节更快
            let running = if small {
                None
            } else {
                match std::mem::replace(&mut *p, Prefetch::Empty) {
                    Prefetch::Running { start, len, join, .. } if prefetch_hit(start, len, offset, take) => {
                        Some((start, join))
                    }
                    other => {
                        *p = other;
                        None
                    }
                }
            };
            drop(p);
            if let Some((start, join)) = running {
                if let Ok(Prefetched { data: Some(data) }) = join.await {
                    if prefetch_hit(start, data.len() as u64, offset, take) {
                        let from = (offset - start) as usize;
                        let buf = data[from..from + take as usize].to_vec();
                        let block_end = start + data.len() as u64;
                        let past_end = offset + take >= block_end;
                        let mut p = slot.prefetch.lock().await;
                        if !past_end && matches!(&*p, Prefetch::Empty) {
                            // 请求只吃掉中段：剩余部分放回供后续命中
                            *p = Prefetch::Ready { start, data };
                        }
                        drop(p);
                        log_serve("在途预取命中", offset, take);
                        if past_end {
                            arm_prefetch(&slot, reader, total, offset + take, ArmKind::Big).await;
                        }
                        return Ok((buf, total));
                    }
                }
                // 在途预取失败或长度不符：落到网络读
            }
        }
        // ② 网络并发分块读；失败淘汰句柄重开重试一次（原地复活多数断线场景）
        match read_pipelined(&reader, offset, take).await {
            Ok(buf) => {
                log_serve("网络读", offset, take);
                let kind = if small { ArmKind::Small } else { ArmKind::Big };
                arm_prefetch(&slot, reader, total, offset + take, kind).await;
                Ok((buf, total))
            }
            Err(first) => {
                invalidate_handle(&slot).await;
                let (reader2, total2) = match ensure_handle(&slot).await {
                    Ok(v) => v,
                    Err(e) => {
                        drop_slot(&slot.path); // 摘槽：下次访问走全新会话（绕开复活冷却期）
                        return Err(format!("读取 {} 失败: {}（重开远程文件失败: {}）", path, first, e));
                    }
                };
                let take2 = take.min(total2.saturating_sub(offset));
                if take2 == 0 {
                    return Ok((Vec::new(), total2));
                }
                match read_pipelined(&reader2, offset, take2).await {
                    Ok(buf) => {
                        log_serve("网络读(重试)", offset, take2);
                        let kind = if small { ArmKind::Small } else { ArmKind::Big };
                        arm_prefetch(&slot, reader2, total2, offset + take2, kind).await;
                        Ok((buf, total2))
                    }
                    Err(e) => {
                        drop_slot(&slot.path);
                        Err(format!("读取 {} 失败: {}（重试仍失败: {}）", path, first, e))
                    }
                }
            }
        }
    };
    match tokio::time::timeout(Duration::from_secs(60), fut).await {
        Ok(inner) => inner,
        Err(_) => Err("读取远程文件超时（60 秒）".into()),
    }
}

/* ========== 远程 zip（RangeSource 复用 zipfile 解析） ========== */

/// smb2 FileReader 的 RangeSource 适配：定位读即网络区间读（中央目录/条目数据各取所需）。
/// 持有会话与路径：读失败（会话断线后句柄必失效）时经 healing stat 重连重开句柄，
/// 重读本区间——每次读取至多重开一次，解析/解压流程对断线无感。
struct SmbReader {
    ses: Arc<SmbSession>,
    rel: String,
    path: String, // 仅用于错误文案
    reader: smb2::client::stream::FileReader,
}

async fn smb_reader_for(
    ses: &Arc<SmbSession>,
    rel: &str,
    path: &str,
) -> Result<SmbReader, String> {
    let (reader, _) = open_smb_reader(ses, rel, path).await?;
    Ok(SmbReader {
        ses: ses.clone(),
        rel: rel.to_string(),
        path: path.to_string(),
        reader,
    })
}

impl crate::zipfile::RangeSource for SmbReader {
    fn read_exact_at<'a>(
        &'a mut self,
        off: u64,
        buf: &'a mut [u8],
    ) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let data = loop {
                match self.reader.read_at(off, buf.len() as u64).await {
                    Ok(data) => break data,
                    Err(_e) => {
                        // 断线：重连（open_smb_reader 内 stat 触发重连重放）+ 重开句柄，再试一次
                        self.reader = open_smb_reader(&self.ses, &self.rel, &self.path)
                            .await
                            .map(|(r, _)| r)
                            .map_err(std::io::Error::other)?;
                        match self.reader.read_at(off, buf.len() as u64).await {
                            Ok(data) => break data,
                            Err(e) => {
                                return Err(std::io::Error::other(format!(
                                    "远程读取失败（已尝试重连）: {}",
                                    e
                                )))
                            }
                        }
                    }
                }
            };
            if data.len() != buf.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    format!("远程读取不足: 请求 {} 字节，得到 {}", buf.len(), data.len()),
                ));
            }
            buf.copy_from_slice(&data);
            Ok(())
        })
    }
}

/// 远程 zip 索引跨命令缓存：路径 → (size, mtime, 索引)。索引重建要多次网络往返，值得缓存
fn zip_index_store() -> &'static Mutex<HashMap<String, (u64, u64, Arc<crate::zipfile::RawZipIndex>)>> {
    static S: OnceLock<Mutex<HashMap<String, (u64, u64, Arc<crate::zipfile::RawZipIndex>)>>> =
        OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 新鲜本地缓存存在 → 返回本地副本路径（zip 整个走本地管线）；
/// 断网时旧缓存也返回（与 open_text 的离线兜底一致）
async fn local_zip_copy(path: &str, cache_dir: &Path) -> Result<Option<PathBuf>, String> {
    let bin = cache_dir.join(format!("{}.bin", key_of(path)));
    if !bin.exists() {
        return Ok(None);
    }
    match stat(path).await {
        Ok((size, mtime, false)) => Ok(if fresh_meta(cache_dir, path, size, mtime) {
            Some(bin)
        } else {
            None
        }),
        Ok((_, _, true)) => Err("这是远程目录".into()),
        Err(_) => Ok(Some(bin)),
    }
}

/// 取（或构建）远程 zip 索引；远程改动（size/mtime 变化）自动失效
async fn zip_index(path: &str) -> Result<Arc<crate::zipfile::RawZipIndex>, String> {
    let (size, mtime, _) = stat(path).await?;
    {
        let store = zip_index_store().lock().unwrap();
        if let Some((s, m, idx)) = store.get(path) {
            if *s == size && *m == mtime {
                return Ok(idx.clone());
            }
        }
    }
    let (cfg, rel) = resolve(path)?;
    let ses = session_for(&cfg.id).await?;
    let mut reader = smb_reader_for(&ses, &rel, path).await?;
    let index = Arc::new(
        tokio::time::timeout(
            Duration::from_secs(60),
            crate::zipfile::parse_index(&mut reader, size),
        )
        .await
        .map_err(|_| "解析远程 zip 超时（60 秒）".to_string())?
        .map_err(|e| format!("解析远程 zip 失败: {}", e))?,
    );
    let mut store = zip_index_store().lock().unwrap();
    if store.len() > 8 {
        store.clear(); // 与本地 zip 缓存同一上限策略
    }
    store.insert(path.to_string(), (size, mtime, index.clone()));
    Ok(index)
}

/// 打开远程文件的区间读句柄。
/// 先 stat 一次再 open：stat 走 client 便捷方法（断线自动重连重放），
/// 把会话救活后 open_file_reader（内部不重试）才不会撞在死连接上。
/// 返回 (FileReader, stat 信息)：句柄是 'static 的，读取在会话锁外并行；
/// 一旦会话重连，旧句柄全部失效（HandleInvalidated），调用方需重开。
/// 目录在此拦下（统一报「远程目录」文案，不依赖服务器侧报错格式）。
async fn open_smb_reader(
    ses: &SmbSession,
    rel: &str,
    path: &str,
) -> Result<(smb2::client::stream::FileReader, smb2::FileInfo), String> {
    let info = {
        let mut core = ses.core.lock().await;
        let SmbCore { client, tree } = &mut *core;
        match with_timeout("访问远程文件", client.stat(tree, rel)).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                evict_session(&ses.cfg.id, &e);
                return Err(format!("无法访问 {}: {}", path, e));
            }
            Err(msg) => return Err(msg),
        }
    };
    if info.is_directory {
        return Err(format!("{} 是远程目录", path));
    }
    let reader = {
        let mut core = ses.core.lock().await;
        let SmbCore { client, tree } = &mut *core;
        match with_timeout("打开远程文件", client.open_file_reader(tree, rel)).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                evict_session(&ses.cfg.id, &e);
                return Err(format!("无法打开远程文件 {}: {}", path, e));
            }
            Err(msg) => return Err(msg),
        }
    };
    Ok((reader, info))
}

/// 列出远程 zip 条目（natural=true 自然排序，false 保持包内原始顺序）
pub async fn list_zip(path: &str, cache_dir: &Path, natural: bool) -> Result<Vec<String>, String> {
    if let Some(bin) = local_zip_copy(path, cache_dir).await? {
        return crate::zipfile::list_zip_files(&bin.to_string_lossy(), natural).await;
    }
    let index = zip_index(path).await?;
    let mut entries: Vec<String> = index.entries.iter().map(|e| e.name.clone()).collect();
    if natural {
        entries.sort_by(|a, b| crate::natural::natural_cmp(a, b));
    }
    Ok(entries)
}

/// 读取远程 zip 条目原始字节：新鲜缓存 → 本地；否则索引 + 定位读条目区间
pub async fn read_zip_entry_raw(
    path: &str,
    entry_name: &str,
    cache_dir: &Path,
) -> Result<Vec<u8>, String> {
    if let Some(bin) = local_zip_copy(path, cache_dir).await? {
        return crate::zipfile::read_zip_entry_raw(&bin.to_string_lossy(), entry_name).await;
    }
    let index = zip_index(path).await?;
    let (cfg, rel) = resolve(path)?;
    let ses = session_for(&cfg.id).await?;
    let mut reader = smb_reader_for(&ses, &rel, path).await?;
    tokio::time::timeout(
        Duration::from_secs(60),
        crate::zipfile::extract_entry(&mut reader, &index, entry_name),
    )
    .await
    .map_err(|_| "读取远程 zip 条目超时（60 秒）".to_string())?
    .map_err(|e| format!("读取 {} 失败: {}", entry_name, e))
}

/// 读取远程 zip 文本条目（编码检测同本地管线）
pub async fn read_zip_entry_text(
    path: &str,
    entry_name: &str,
    forced: Option<&str>,
    cache_dir: &Path,
) -> Result<(String, String), String> {
    let buf = read_zip_entry_raw(path, entry_name, cache_dir).await?;
    crate::zipfile::decode_bytes(&buf, forced)
}

/// 远程上一集/下一集：列远程父目录 → 同扩展名过滤 → 排序（natural=true 自然 /
/// false 智能序号）→ 纯函数定位。
/// 返回完整 smb:// 路径。连载场景 zip→zip 接续同样覆盖（realPath 即 zip 的 smb 路径）。
pub async fn find_sibling(
    path: &str,
    forward: bool,
    natural: bool,
    cache_dir: &Path,
) -> Result<Option<String>, String> {
    let pure = path.split("::").next().unwrap_or(path);
    let (parent_smb, cur_name) = match pure.rsplit_once('/') {
        Some((p, n)) => (p.to_string(), n.to_string()),
        None => (pure.to_string(), String::new()),
    };
    if cur_name.is_empty() {
        return Ok(None);
    }
    let entries = list_dir(&parent_smb, cache_dir, natural).await?;
    // 与本地 list_sibling_files 同语义：同扩展名文件（无扩展名按 txt）
    let ext = cur_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_else(|| "txt".to_string());
    let mut files: Vec<(String, String)> = entries
        .iter()
        .filter(|e| {
            !e.entry.is_dir
                && e.entry
                    .name
                    .rsplit_once('.')
                    .map(|(_, x)| x.eq_ignore_ascii_case(&ext))
                    .unwrap_or(ext == "txt")
        })
        .map(|e| (e.entry.name.clone(), e.entry.path.clone()))
        .collect();
    files.sort_by(|a, b| {
        if natural {
            crate::natural::natural_cmp(&a.0, &b.0)
        } else {
            crate::seqfile::seq_cmp(&a.0, &b.0)
        }
    });
    let names: Vec<String> = files.iter().map(|(n, _)| n.clone()).collect();
    let idx = names.iter().position(|n| n == &cur_name);
    let picked = if forward {
        crate::seqfile::next_among(&names, &cur_name, idx)
    } else {
        // 上一集没有「兜底到末尾」语义：未命中直接无
        idx.and_then(|i| crate::seqfile::prev_among(&names, i))
    };
    Ok(picked.and_then(|n| files.iter().find(|(x, _)| x == &n).map(|(_, p)| p.clone())))
}

/* ========== 远程写操作（2026-10-29 起，反转「远程侧只读」spike 决定） ==========
   递归删除链接策略：列表层 is_link 命中的只删链接本身不进目标；Samba 会把 unix
   符号链接按目标类型列出，故递归进子目录前额外 stat 查 is_link 兜底（勿「优化」掉）。 */

/// 删除远程文件或目录（目录递归）。SMB 无回收站，前端负责两段式确认后再调。
pub async fn delete_path(path: &str) -> Result<(), String> {
    if path.contains("::") {
        return Err("路径不是远程文件或目录".into());
    }
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("不能删除共享根目录".into());
    }
    let ses = session_for(&cfg.id).await?;
    let mut core = ses.core.lock().await;
    let SmbCore { client, tree } = &mut *core;
    delete_locked(&cfg.id, client, tree, &rel).await
}

/// 递归删除 rel（文件或目录）。要求调用方已持会话锁。
/// 递归中途失败即返回错误（尽力而为，不回滚；剩余部分可重新删除续删）。
/// 链接（junction/符号链接）只删链接本身，绝不跟随进目标删内容：
/// 列表层 e.is_link() 命中的直接 del_link_locked；Samba 会把 unix 符号链接
/// 按目标类型列出（列表层 is_link 为 false），兜底靠递归入口的 stat——
/// 每个子目录递归前必先经入口 stat 查 FileInfo::is_link()，为真即删链接
/// 不再下钻（勿「优化」掉这次 stat）。
async fn delete_locked(
    id: &str,
    client: &mut SmbClient,
    tree: &mut Tree,
    rel: &str,
) -> Result<(), String> {
    let info = match with_timeout("访问远程文件", client.stat(tree, rel)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            evict_session(id, &e);
            return Err(format!("无法访问 {}: {}（已删部分不可恢复，重试可续删）", rel, e));
        }
        Err(msg) => return Err(msg),
    };
    if info.is_link() {
        return del_link_locked(id, client, tree, rel).await;
    }
    if !info.is_directory {
        return del_file_locked(id, client, tree, rel).await;
    }
    // list_directory 的目录参数带尾斜杠（同 pub list_dir 惯例）
    let list_path = format!("{}/", rel);
    let entries = match with_timeout("列目录", client.list_directory(tree, &list_path)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            evict_session(id, &e);
            return Err(format!("无法读取目录 {}: {}（已删部分不可恢复，重试可续删）", rel, e));
        }
        Err(msg) => return Err(msg),
    };
    for e in entries {
        if e.name == "." || e.name == ".." {
            continue;
        }
        let child = format!("{}/{}", rel, e.name);
        if e.is_link() {
            // 列表层已标记链接：只删链接本身，不进目标
            del_link_locked(id, client, tree, &child)
                .await
                .map_err(|m| format!("{m}（已删部分不可恢复，重试可续删）"))?;
        } else if e.is_directory {
            // Samba 列表层会把 unix 符号链接按目录列出：递归入口的 stat
            // is_link 检查是兜底，命中则只删链接（见函数头注释）
            // async 递归须 Box::pin 打破无限大小 future
            Box::pin(delete_locked(id, client, tree, &child)).await?;
        } else {
            del_file_locked(id, client, tree, &child)
                .await
                .map_err(|m| format!("{m}（已删部分不可恢复，重试可续删）"))?;
        }
    }
    match with_timeout("删除目录", client.delete_directory(tree, rel)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            evict_session(id, &e);
            Err(format!("删除目录 {} 失败: {}（已删部分不可恢复，重试可续删）", rel, e))
        }
        Err(msg) => Err(msg),
    }
}

async fn del_file_locked(
    id: &str,
    client: &mut SmbClient,
    tree: &mut Tree,
    rel: &str,
) -> Result<(), String> {
    match with_timeout("删除文件", client.delete_file(tree, rel)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            evict_session(id, &e);
            Err(format!("删除 {} 失败: {}", rel, e))
        }
        Err(msg) => Err(msg),
    }
}

/// 删除链接本身（junction/符号链接），目标内容不动（crate 内带 FILE_OPEN_REPARSE_POINT）
async fn del_link_locked(
    id: &str,
    client: &mut SmbClient,
    tree: &mut Tree,
    rel: &str,
) -> Result<(), String> {
    match with_timeout("删除链接", client.delete_link(tree, rel)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            evict_session(id, &e);
            Err(format!("删除链接 {} 失败: {}", rel, e))
        }
        Err(msg) => Err(msg),
    }
}

/// 远程同目录重命名
pub async fn rename_path(path: &str, new_name: &str) -> Result<(), String> {
    if path.contains("::") {
        return Err("路径不是远程文件或目录".into());
    }
    let new_name = new_name.trim();
    if new_name.is_empty()
        || new_name.contains('/')
        || new_name.contains('\\')
        || new_name == "."
        || new_name == ".."
    {
        return Err("名称不能为空，不能是 . 或 ..，且不能包含 / \\ 字符".into());
    }
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("共享根不能重命名".into());
    }
    let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let target = format!("{}/{}", parent, new_name);
    let ses = session_for(&cfg.id).await?;
    let mut core = ses.core.lock().await;
    let SmbCore { client, tree } = &mut *core;
    rename_locked(&cfg.id, client, tree, &rel, &target, "重命名").await
}

/// 远程同共享内移动（重命名到另一目录）。跨服务器/跨共享明确不支持。
pub async fn move_path(path: &str, to_dir: &str) -> Result<(), String> {
    if path.contains("::") || to_dir.contains("::") {
        return Err("路径不是远程文件或目录".into());
    }
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("共享根不能移动".into());
    }
    let (cfg_to, rel_to) = resolve(to_dir)?;
    if cfg.id != cfg_to.id {
        return Err("跨服务器移动暂不支持".into());
    }
    if rel_to == rel || rel_to.starts_with(&format!("{}/", rel)) {
        return Err("不能移动到自身或其子目录内".into());
    }
    let src_parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    if rel_to == src_parent {
        return Err("目标目录与当前所在目录相同".into());
    }
    let name = rel.rsplit_once('/').map(|(_, n)| n).unwrap_or(&rel);
    let target = format!("{}/{}", rel_to, name);
    let ses = session_for(&cfg.id).await?;
    let mut core = ses.core.lock().await;
    let SmbCore { client, tree } = &mut *core;
    rename_locked(&cfg.id, client, tree, &rel, &target, "移动").await
}

async fn rename_locked(
    id: &str,
    client: &mut SmbClient,
    tree: &mut Tree,
    from: &str,
    to: &str,
    what: &str,
) -> Result<(), String> {
    match with_timeout(what, client.rename(tree, from, to)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            evict_session(id, &e);
            Err(format!("{}失败: {}", what, e))
        }
        Err(msg) => Err(msg),
    }
}

/// 远程新建文件夹
pub async fn make_dir(parent: &str, name: &str) -> Result<(), String> {
    if parent.contains("::") {
        return Err("路径不是远程文件或目录".into());
    }
    let name = name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
    {
        return Err("名称不能为空，不能是 . 或 ..，且不能包含 / \\ 字符".into());
    }
    let (cfg, rel) = resolve(parent)?;
    let target = if rel.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", rel, name)
    };
    let ses = session_for(&cfg.id).await?;
    let mut core = ses.core.lock().await;
    let SmbCore { client, tree } = &mut *core;
    match with_timeout("新建文件夹", client.create_directory(tree, &target)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            evict_session(&cfg.id, &e);
            Err(format!("创建失败: {}", e))
        }
        Err(msg) => Err(msg),
    }
}

/* ========== 流式播放（句柄常驻 + 并发分块读 + 块间预取） ========== */

#[cfg(test)]
mod stream_tests {
    use super::*;

    /* ---------- plan_sub_reads：把 [offset, offset+len) 拆成 wire READ 子区间 ---------- */

    #[test]
    fn sub_reads_split_exact_multiple() {
        // 1024 字节按 512 拆：两段整块
        assert_eq!(plan_sub_reads(0, 1024, 4096, 512), vec![(0, 512), (512, 512)]);
    }

    #[test]
    fn sub_reads_split_with_remainder() {
        assert_eq!(
            plan_sub_reads(0, 1025, 4096, 512),
            vec![(0, 512), (512, 512), (1024, 1)]
        );
    }

    #[test]
    fn sub_reads_clamped_to_eof() {
        // 请求超出文件尾：末段截到 total
        assert_eq!(plan_sub_reads(4000, 8 * 1024 * 1024, 4096, 512), vec![(4000, 96)]);
    }

    #[test]
    fn sub_reads_empty_past_eof_or_zero_len() {
        assert!(plan_sub_reads(4096, 100, 4096, 512).is_empty()); // offset==total
        assert!(plan_sub_reads(5000, 100, 4096, 512).is_empty()); // offset>total
        assert!(plan_sub_reads(0, 0, 4096, 512).is_empty()); // 零长度
    }

    #[test]
    fn sub_reads_single_when_sub_exceeds_len() {
        assert_eq!(plan_sub_reads(100, 10, 4096, 512), vec![(100, 10)]);
    }

    /* ---------- prefetch_hit：预取块必须完整覆盖请求区间才算命中 ---------- */

    #[test]
    fn prefetch_hit_requires_full_cover() {
        assert!(prefetch_hit(0, 100, 0, 100)); // 完全一致
        assert!(prefetch_hit(0, 100, 10, 10)); // 请求是预取块的子区间
        assert!(!prefetch_hit(0, 100, 0, 101)); // 尾部超出预取块
        assert!(!prefetch_hit(50, 100, 40, 20)); // 头部在预取块之前
        assert!(!prefetch_hit(0, 100, 200, 10)); // 完全不相干
    }

    /* ---------- 端到端（需真实 SMB 服务器，默认忽略） ----------
       R4E_SMB_HOST（可带 :端口） / R4E_SMB_SHARE / R4E_SMB_USER / R4E_SMB_PASS
       / R4E_SMB_FILE（share 内相对路径，建议 16–64MB 的文件）
       cargo test --lib smb::stream_tests::e2e_real_server -- --ignored --nocapture */
    #[tokio::test]
    #[ignore = "需要真实 SMB 服务器（设置 R4E_SMB_HOST/SHARE/USER/PASS/FILE）"]
    async fn e2e_real_server() {
        let host = std::env::var("R4E_SMB_HOST").expect("缺少 R4E_SMB_HOST");
        let share = std::env::var("R4E_SMB_SHARE").expect("缺少 R4E_SMB_SHARE");
        let file = std::env::var("R4E_SMB_FILE").expect("缺少 R4E_SMB_FILE");
        let cfg = crate::store::SmbServer {
            id: "e2e".into(),
            name: "e2e".into(),
            host,
            share: share.clone(),
            workgroup: String::new(),
            username: std::env::var("R4E_SMB_USER").unwrap_or_default(),
            password: std::env::var("R4E_SMB_PASS").unwrap_or_default(),
        };
        put_servers(vec![cfg]);
        let path = format!("smb://e2e/{}/{}", share, file);

        // 总长与整读基准一致
        let total = stream_meta(&path).await.unwrap();
        let full = read_all(&path).await.unwrap();
        assert_eq!(full.len() as u64, total, "stream_meta 总长应与整读一致");

        // 8MB 顺序分块重组一致；块间留 600ms 模拟播放消耗——预取任务在间隙完成，
        // 后续块稳定走 Ready 命中路径（不间歇则随机走 Running 等待路径，两者皆正确）
        let t0 = std::time::Instant::now();
        let mut off = 0u64;
        let mut assembled: Vec<u8> = Vec::with_capacity(total as usize);
        while off < total {
            let len = STREAM_PREFETCH.min(total - off);
            let (b, t) = stream_read(&path, off, len).await.unwrap();
            assert_eq!(t, total);
            assert_eq!(b.len() as u64, len);
            assembled.extend_from_slice(&b);
            off += len;
            if off < total {
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }
        assert_eq!(assembled, full, "分块重组应与整读逐字节一致");
        eprintln!(
            "顺序 {} 块（{} MB）耗时 {:?}",
            total.div_ceil(STREAM_PREFETCH),
            total / 1024 / 1024,
            t0.elapsed()
        );

        // 预取命中后的小区间读（块中段）
        if total > STREAM_PREFETCH + 12345 + 6789 {
            let (b, _) = stream_read(&path, STREAM_PREFETCH + 12345, 6789).await.unwrap();
            assert_eq!(&b[..], &full[(STREAM_PREFETCH + 12345) as usize..][..6789]);
        }

        // 随机偏移读（seek 场景，预取不命中走网络分块）
        if total > 300 * 1024 {
            let (b, _) = stream_read(&path, 300 * 1024 - 7, 4096).await.unwrap();
            assert_eq!(&b[..], &full[(300 * 1024 - 7) as usize..][..4096]);
        }

        // 目录应报错而非打开
        assert!(stream_meta(&path.rsplit_once('/').unwrap().0).await.is_err());
    }

    /* ---------- 微读不触发兆级下载（需真实服务器，默认忽略） ----------
       复现 2026-11-03 线上日志病灶：WebKit 解析 mp4 索引（moov 常在文件尾）时发
       4–100B 微读，曾因「微读等/拉整块 8MB 预取 + Ready 整块丢弃 + 微读也 arm
       大块」反向优化成一帧一帧爬。成对偏移（A 然后 A+8）保证第二读落进刚布防的
       预取区间——旧代码每对都等满 8MB。断言微读序列的网络字节数保持在小量级。
       cargo test --lib smb::stream_tests::tiny_reads_dont_megaload -- --ignored --nocapture */
    #[tokio::test]
    #[ignore = "需要真实 SMB 服务器（设置 R4E_SMB_HOST/SHARE/USER/PASS/FILE）"]
    async fn tiny_reads_dont_megaload() {
        let host = std::env::var("R4E_SMB_HOST").expect("缺少 R4E_SMB_HOST");
        let share = std::env::var("R4E_SMB_SHARE").expect("缺少 R4E_SMB_SHARE");
        let file = std::env::var("R4E_SMB_FILE").expect("缺少 R4E_SMB_FILE");
        let cfg = crate::store::SmbServer {
            id: "e2e".into(),
            name: "e2e".into(),
            host,
            share: share.clone(),
            workgroup: String::new(),
            username: std::env::var("R4E_SMB_USER").unwrap_or_default(),
            password: std::env::var("R4E_SMB_PASS").unwrap_or_default(),
        };
        put_servers(vec![cfg]);
        let path = format!("smb://e2e/{}/{}", share, file);
        let total = stream_meta(&path).await.unwrap();
        assert!(total > 1024 * 1024, "需大于 1MB 的文件");
        let full = read_all(&path).await.unwrap();

        // 清场大读选在文件尾：读毕 offset+take == total，不会布防任何预取，
        // 快照之后不再有大块后台下载混入统计
        let _ = stream_read(&path, total - 8192, 8192).await.unwrap();

        let tail = total - 4096;
        let offs: Vec<u64> = vec![
            0, 8, 100, 108, 4096, 4104, tail, tail + 8, tail + 200, tail + 208,
        ];
        let before = net_bytes_for_test();
        for &o in &offs {
            let (b, t) = stream_read(&path, o, 8).await.unwrap();
            assert_eq!(t, total);
            assert_eq!(&b[..], &full[o as usize..][..8], "微读数据不符 @{}", o);
        }
        let spent = net_bytes_for_test() - before;
        eprintln!("微读 {} 次共网络读 {} 字节", offs.len(), spent);
        assert!(
            spent < 4 * 1024 * 1024,
            "微读触发了兆级下载（{} 字节）——预取策略被微读打穿",
            spent
        );
    }

    /* ---------- 微读应布防小块预取（需真实服务器，默认忽略） ----------
       复现 2026-11-03 第二版日志：槽内留着远处大块 Ready 时，微读的小块布防被
       「不丢大块 Ready」策略全部拒绝——整个窗口零预取命中，每笔微读都付整往返
       （播放器请求串行，有效下行被掐到 ~20KB/s）。修后：微读 Miss 应换掉
       远处陈旧 Ready、布防小块（在途任务仍不打断）。
       cargo test --lib smb::stream_tests::tiny_reads_arm_small_prefetch -- --ignored --nocapture */
    #[tokio::test]
    #[ignore = "需要真实 SMB 服务器（设置 R4E_SMB_HOST/SHARE/USER/PASS/FILE）"]
    async fn tiny_reads_arm_small_prefetch() {
        let host = std::env::var("R4E_SMB_HOST").expect("缺少 R4E_SMB_HOST");
        let share = std::env::var("R4E_SMB_SHARE").expect("缺少 R4E_SMB_SHARE");
        let file = std::env::var("R4E_SMB_FILE").expect("缺少 R4E_SMB_FILE");
        let cfg = crate::store::SmbServer {
            id: "e2e".into(),
            name: "e2e".into(),
            host,
            share: share.clone(),
            workgroup: String::new(),
            username: std::env::var("R4E_SMB_USER").unwrap_or_default(),
            password: std::env::var("R4E_SMB_PASS").unwrap_or_default(),
        };
        put_servers(vec![cfg]);
        let path = format!("smb://e2e/{}/{}", share, file);
        let total = stream_meta(&path).await.unwrap();
        assert!(total > 1024 * 1024, "需大于 1MB 的文件");
        let full = read_all(&path).await.unwrap();

        // 制造远处的大块 Ready：读 [0, 8MB) 布防 [8MB,16MB)，等它落盘
        let _ = stream_read(&path, 0, STREAM_PREFETCH).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        // 远离大块区域的连续微读（步进 1KB）
        let base = total / 2;
        let before = net_bytes_for_test();
        for i in 0..10u64 {
            let o = base + i * 1000;
            let (b, _) = stream_read(&path, o, 700).await.unwrap();
            assert_eq!(&b[..], &full[o as usize..][..700], "微读数据不符 @{}", o);
        }
        let spent = net_bytes_for_test() - before;
        eprintln!("远处大块在场时微读 10 次网络读 {} 字节", spent);
        assert!(
            spent >= 200 * 1024,
            "微读未布防小块预取（仅 {} 字节）——远处大块 Ready 把小块布防饿死了",
            spent
        );
        assert!(spent <= 2 * 1024 * 1024, "微读又触发兆级下载（{} 字节）", spent);
    }

    /* ---------- 并发压力（需真实服务器，默认忽略）：模拟 WebKit 混合请求 ----------
       三路并发打同一文件：A 顺序 8MB 大块（重组必须逐字节正确）、B 随机 seek、
       C 小读+重复读。验证播放槽/预取/句柄在并发下无死锁无串数据。
       cargo test --lib smb::stream_tests::stress_real_server -- --ignored --nocapture */
    #[tokio::test]
    #[ignore = "需要真实 SMB 服务器（设置 R4E_SMB_HOST/SHARE/USER/PASS/FILE）"]
    async fn stress_real_server() {
        let host = std::env::var("R4E_SMB_HOST").expect("缺少 R4E_SMB_HOST");
        let share = std::env::var("R4E_SMB_SHARE").expect("缺少 R4E_SMB_SHARE");
        let file = std::env::var("R4E_SMB_FILE").expect("缺少 R4E_SMB_FILE");
        let cfg = crate::store::SmbServer {
            id: "e2e".into(),
            name: "e2e".into(),
            host,
            share: share.clone(),
            workgroup: String::new(),
            username: std::env::var("R4E_SMB_USER").unwrap_or_default(),
            password: std::env::var("R4E_SMB_PASS").unwrap_or_default(),
        };
        put_servers(vec![cfg]);
        let path = format!("smb://e2e/{}/{}", share, file);
        let total = stream_meta(&path).await.unwrap();
        let full = Arc::new(read_all(&path).await.unwrap());
        assert_eq!(full.len() as u64, total);
        assert!(total > 5 * 1024 * 1024, "压力测试需大于 5MB 的文件");

        // A：顺序大块（每块之间短暂停顿，播放节奏）
        let pa = path.clone();
        let fa = full.clone();
        let task_a = tokio::spawn(async move {
            let mut off = 0u64;
            let mut assembled: Vec<u8> = Vec::with_capacity(fa.len());
            while off < total {
                let len = STREAM_PREFETCH.min(total - off);
                let (b, t) = stream_read(&pa, off, len).await.expect("A 顺序读失败");
                assert_eq!(t, total);
                assert_eq!(b.len() as u64, len, "A 块长不符 @{}", off);
                assembled.extend_from_slice(&b);
                off += len;
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            assert_eq!(assembled, *fa, "A 重组数据不一致");
        });

        // B：随机 seek（每次读 64–512KB，预取应被反复打断替换）
        let pb = path.clone();
        let fb = full.clone();
        let task_b = tokio::spawn(async move {
            let mut seed = 0x2545F4914F6CDD1Du64;
            for _ in 0..24 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let span = total.saturating_sub(1024 * 1024).max(1);
                let off = (seed >> 16) % span;
                let len = 64 * 1024 + (seed % 7) * 64 * 1024;
                let (b, _) = stream_read(&pb, off, len.min(total - off)).await.expect("B 随机读失败");
                assert_eq!(&b[..], &fb[off as usize..][..b.len()], "B 数据不一致 @{}", off);
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        });

        // C：小读 + 重复读同区间（触发 Ready 余量复用）
        let pc = path;
        let fc = full;
        let task_c = tokio::spawn(async move {
            for i in 0..16 {
                let off = (i % 4) * 1024 * 1024 + 12345;
                let (b, _) = stream_read(&pc, off, 6789).await.expect("C 小读失败");
                assert_eq!(&b[..], &fc[off as usize..][..6789], "C 数据不一致 @{}", off);
            }
        });

        let (ra, rb, rc) = tokio::join!(task_a, task_b, task_c);
        ra.unwrap();
        rb.unwrap();
        rc.unwrap();
        eprintln!("stress: 三路并发（顺序+随机 seek+小读）全部通过");
    }
}

