use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use crate::encoding::{decode_with, detect_and_decode};

/// 列出 zip 内所有 .txt 文件（含路径）。前端现在用 list_zip_files 自行过滤，
/// 此函数保留给宽容解析测试与潜在调用方。
#[allow(dead_code)]
pub fn list_zip_txt(path: &str) -> Result<Vec<String>, String> {
    Ok(list_zip_files(path)?
        .into_iter()
        .filter(|n| n.to_ascii_uppercase().ends_with(".TXT"))
        .collect())
}

/// 列出 zip 内全部文件条目（含路径，不过滤类型）
pub fn list_zip_files(path: &str) -> Result<Vec<String>, String> {
    let entry = cache_entry(path)?;
    Ok(entry.index.entries.iter().map(|e| e.name.clone()).collect())
}

/// 读取 zip 内指定条目的原始字节（不做文本解码）。
/// 中央目录只在首次访问时解析一次（缓存在进程内），条目数据按需 seek 读取——
/// 网络驱动器上的大 zip 不再重复打开/整文件读取/逐条目往返。
pub fn read_zip_entry_raw(path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let entry = cache_entry(path)?;
    let e = entry
        .index
        .entries
        .iter()
        .find(|x| x.name == entry_name)
        .ok_or_else(|| format!("zip 内未找到: {}", entry_name))?;
    let mut f = entry.file.try_clone().map_err(|e| format!("zip 句柄不可用: {}", e))?;
    extract_entry_ranged(&mut f, e)
}

/// 读取 zip 内指定 txt 条目。forced_encoding 不为 None 时按指定编码解码。
pub fn read_zip_entry(
    path: &str,
    entry_name: &str,
    forced_encoding: Option<&str>,
) -> Result<(String, String), String> {
    let buf = read_zip_entry_raw(path, entry_name)?;
    decode_bytes(&buf, forced_encoding)
}

fn decode_bytes(buf: &[u8], forced_encoding: Option<&str>) -> Result<(String, String), String> {
    if let Some(enc) = forced_encoding {
        return decode_with(buf, enc);
    }
    let (text, enc) = detect_and_decode(buf);
    Ok((text, enc.to_string()))
}

/// zip 条目名：UTF-8 有效则原样，否则按 GB18030 解码（老中文打包器常用 GBK 存名）
fn decode_zip_name(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (s, _, _) = encoding_rs::GB18030.decode(raw);
            s.into_owned()
        }
    }
}

/// 判断文件是否是 zip
pub fn is_zip_file(path: &str) -> bool {
    if let Ok(mut f) = File::open(path) {
        let mut header = [0u8; 4];
        if f.read_exact(&mut header).is_ok() {
            // PK\x03\x04
            return header == [0x50, 0x4B, 0x03, 0x04];
        }
    }
    false
}

/// 读取普通 txt 文件。forced_encoding 不为 None 时按指定编码解码。
pub fn read_text_file(path: &str, forced_encoding: Option<&str>) -> Result<(String, String), String> {
    let p = Path::new(path);
    let mut buf = Vec::new();
    let mut f = File::open(p).map_err(|e| format!("打开文件失败: {}", e))?;
    f.read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    decode_bytes(&buf, forced_encoding)
}

/* ========== ZIP 进程内缓存 ==========
   中央目录（或宽容索引）只解析一次，条目数据按需 seek 读取。
   针对：每次读条目都重开 zip + 解析目录，以及网络驱动器上整文件读取的问题。
   实现说明：不再使用 zip crate 的 ZipArchive——它对中文打包器写坏的 zip 会在
   解析阶段拒绝且耗时数百毫秒；自研解析兼容标准与损坏布局（含 ZIP64 尾部）。 */

struct RawEntry {
    name: String,
    method: u16,
    compressed_size: u64,
    header_offset: u64,
}

struct RawZipIndex {
    entries: Vec<RawEntry>,
}

struct CacheEntry {
    mtime_ms: u64,
    len: u64,
    index: RawZipIndex,
    file: File,
}

fn cache_store() -> &'static Mutex<HashMap<String, Arc<CacheEntry>>> {
    static STORE: OnceLock<Mutex<HashMap<String, Arc<CacheEntry>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_sig(path: &str) -> Option<(u64, u64)> {
    let md = fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime, md.len()))
}

/// 取（或构建）路径对应的缓存条目；文件变化（mtime/大小）时自动重建
fn cache_entry(path: &str) -> Result<Arc<CacheEntry>, String> {
    let sig = file_sig(path).ok_or_else(|| format!("无法读取 zip: {}", path))?;
    {
        let store = cache_store().lock().unwrap();
        if let Some(e) = store.get(path) {
            if e.mtime_ms == sig.0 && e.len == sig.1 {
                return Ok(e.clone());
            }
        }
    }
    let entry = Arc::new(build_cache_entry(path, sig)?);
    let mut store = cache_store().lock().unwrap();
    if store.len() > 8 {
        store.clear(); // 缓存上限：超过 8 个 zip 全清（低频重建，代价小）
    }
    store.insert(path.to_string(), entry.clone());
    Ok(entry)
}

fn build_cache_entry(path: &str, sig: (u64, u64)) -> Result<CacheEntry, String> {
    let mut file = File::open(path).map_err(|e| format!("打开 zip 失败: {}", e))?;
    // 条目名/索引统一用 seek 式解析：只读 EOCD 尾部与中央目录（2 次网络读），
    // 绝不逐条目 by_index——那会对每个条目产生一次网络往返（网络驱动器上极慢）。
    let index = match parse_raw_index_seeking(&mut file, sig.1) {
        Ok(index) => index,
        Err(_) => {
            // 特殊布局兜底：整文件读取后按原逻辑解析（一次性付出，常见布局不走这里）
            let t1 = std::time::Instant::now();
            let data = fs::read(path).map_err(|e| format!("打开 zip 失败: {}", e))?;
            let index = RawZipIndex::parse(&data)?;
            eprintln!(
                "[zip] seek 解析失败 → 整文件兜底（{:.0}MB，{:?}）",
                data.len() as f64 / 1e6,
                t1.elapsed()
            );
            index
        }
    };
    Ok(CacheEntry {
        mtime_ms: sig.0,
        len: sig.1,
        index,
        file,
    })
}

/* ========== 宽容 ZIP 解析（仅支持传统 32 位布局 + ZIP64 尾部，用于兼容损坏 zip） ========== */

const SIG_LFH: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];
const SIG_CDFH: [u8; 4] = [0x50, 0x4B, 0x01, 0x02];
const SIG_EOCD: [u8; 4] = [0x50, 0x4B, 0x05, 0x06];

fn u16_at(data: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(off..off + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(off..off + 4)?.try_into().ok()?))
}

/// 在缓冲区尾部（EOCD 注释最长 64KB）反向查找中央目录结尾记录
fn find_eocd(data: &[u8]) -> Option<usize> {
    if data.len() < 22 {
        return None;
    }
    let lo = data.len().saturating_sub(22 + 65536);
    (lo..=data.len() - 22).rev().find(|&i| data[i..i + 4] == SIG_EOCD)
}

/// seek 版宽容索引：只读 EOCD 尾部与中央目录，不整文件读取。
/// 条目名统一 decode_zip_name（UTF-8 → GB18030 回退）。
/// 支持标准与 ZIP64 尾部；中央目录声明位置异常（前置数据等）时返回 Err，
/// 由调用方回退整文件解析。
fn parse_raw_index_seeking(file: &mut File, len: u64) -> Result<RawZipIndex, String> {
    if len < 22 {
        return Err("文件太小，不是 zip".into());
    }
    let tail_len = std::cmp::min(len as usize, 22 + 65535);
    file.seek(SeekFrom::Start(len - tail_len as u64))
        .map_err(|e| format!("seek 失败: {}", e))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| format!("读取 zip 尾部失败: {}", e))?;
    let eocd = find_eocd(&tail).ok_or("EOCDmarker")?;
    let eocd_abs = (len - tail_len as u64) + eocd as u64;
    let mut entries_total = u16_at(&tail, eocd + 10).ok_or("EOCD 损坏")? as u64;
    let mut cd_size = u32_at(&tail, eocd + 12).ok_or("EOCD 损坏")? as u64;
    let mut cd_offset = u32_at(&tail, eocd + 16).ok_or("EOCD 损坏")? as u64;

    // ZIP64：标准 EOCD 字段为哨兵值时，读取 EOCD 前 20 字节的定位器与 ZIP64 EOCD
    if entries_total == 0xFFFF || cd_size == 0xFFFFFFFF || cd_offset == 0xFFFFFFFF {
        if eocd_abs < 20 {
            return Err("EOCDmarker".into());
        }
        file.seek(SeekFrom::Start(eocd_abs - 20))
            .map_err(|e| format!("seek 失败: {}", e))?;
        let mut loc = [0u8; 20];
        file.read_exact(&mut loc)
            .map_err(|e| format!("读取 ZIP64 定位器失败: {}", e))?;
        if loc[0..4] != [0x50, 0x4B, 0x06, 0x07] {
            return Err("EOCDmarker".into());
        }
        let z64_off = u64::from_le_bytes(loc[8..16].try_into().ok().ok_or("ZIP64 定位器损坏")?);
        file.seek(SeekFrom::Start(z64_off))
            .map_err(|e| format!("seek 失败: {}", e))?;
        let mut z64 = [0u8; 56];
        file.read_exact(&mut z64)
            .map_err(|e| format!("读取 ZIP64 EOCD 失败: {}", e))?;
        if z64[0..4] != [0x50, 0x4B, 0x06, 0x06] {
            return Err("EOCDmarker".into());
        }
        entries_total = u64::from_le_bytes(z64[32..40].try_into().ok().ok_or("ZIP64 EOCD 损坏")?);
        cd_size = u64::from_le_bytes(z64[40..48].try_into().ok().ok_or("ZIP64 EOCD 损坏")?);
        cd_offset = u64::from_le_bytes(z64[48..56].try_into().ok().ok_or("ZIP64 EOCD 损坏")?);
    }

    let cd_len = std::cmp::min(cd_size, (256 * 1024 * 1024) as u64);
    if cd_len < 4 {
        return Err("EOCDmarker".into()); // 布局不标准 → 整文件兜底
    }
    file.seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("seek 失败: {}", e))?;
    let mut cd = vec![0u8; cd_len as usize];
    file.read_exact(&mut cd)
        .map_err(|e| format!("读取中央目录失败: {}", e))?;
    if cd[0..4] != SIG_CDFH {
        return Err("EOCDmarker".into()); // 布局不标准 → 整文件兜底
    }

    let mut entries = Vec::with_capacity((entries_total as usize).min(65536));
    let mut p = 0usize;
    for _ in 0..entries_total {
        if cd.get(p..p + 4) != Some(&SIG_CDFH) {
            break;
        }
        let method = u16_at(&cd, p + 10).ok_or("中央目录条目损坏")?;
        let mut uncompressed_size = u32_at(&cd, p + 24).ok_or("中央目录条目损坏")? as u64;
        let mut compressed_size = u32_at(&cd, p + 20).ok_or("中央目录条目损坏")? as u64;
        let name_len = u16_at(&cd, p + 28).ok_or("中央目录条目损坏")? as usize;
        let extra_len = u16_at(&cd, p + 30).ok_or("中央目录条目损坏")? as usize;
        let comment_len = u16_at(&cd, p + 32).ok_or("中央目录条目损坏")? as usize;
        let mut header_offset = u32_at(&cd, p + 42).ok_or("中央目录条目损坏")? as u64;
        let name_bytes = cd.get(p + 46..p + 46 + name_len).ok_or("中央目录条目损坏")?;
        // 中文电子书场景：UTF-8 无效时按 GB18030 解码（与 decode_zip_name 一致）
        let name = decode_zip_name(name_bytes);
        let extra = cd
            .get(p + 46 + name_len..p + 46 + name_len + extra_len)
            .unwrap_or(&[]);
        apply_zip64_entry_values(
            extra,
            &mut uncompressed_size,
            &mut compressed_size,
            &mut header_offset,
        );
        entries.push(RawEntry {
            name,
            method,
            compressed_size,
            header_offset,
        });
        p += 46 + name_len + extra_len + comment_len;
    }
    if entries.is_empty() {
        return Err("ZIP 中没有可识别的文件条目".to_string());
    }
    Ok(RawZipIndex { entries })
}

/// ZIP64 扩展字段（0x0001）：CD 中 0xFFFFFFFF 的字段按
/// 未压缩尺寸 → 压缩尺寸 → 头偏移 的顺序把真实值存于该扩展中
fn apply_zip64_entry_values(
    extra: &[u8],
    uncompressed: &mut u64,
    compressed: &mut u64,
    header_offset: &mut u64,
) {
    let mut q = 0usize;
    while q + 4 <= extra.len() {
        let id = u16_at(extra, q).unwrap_or(0);
        let sz = u16_at(extra, q + 2).unwrap_or(0) as usize;
        let data = match extra.get(q + 4..q + 4 + sz) {
            Some(d) => d,
            None => break,
        };
        if id == 0x0001 {
            // 顺序：未压缩 → 压缩 → 头偏移（仅对应 CD 中为 0xFFFFFFFF 的字段）
            let mut cursor = 0usize;
            let mut had = |need: bool| {
                if need && cursor + 8 <= data.len() {
                    let v = u64::from_le_bytes(data[cursor..cursor + 8].try_into().ok().unwrap_or([0; 8]));
                    cursor += 8;
                    Some(v)
                } else {
                    None
                }
            };
            if let Some(v) = had(*uncompressed == 0xFFFFFFFF) {
                *uncompressed = v;
            }
            if let Some(v) = had(*compressed == 0xFFFFFFFF) {
                *compressed = v;
            }
            if let Some(v) = had(*header_offset == 0xFFFFFFFF) {
                *header_offset = v;
            }
            break;
        }
        q += 4 + sz;
    }
}

/// 整文件读取版宽容索引（兜底：前置数据/特殊布局的损坏 zip）
impl RawZipIndex {
    fn parse(data: &[u8]) -> Result<Self, String> {
        let eocd = find_eocd(data).ok_or_else(|| "未能定位 ZIP 中央目录结尾（EOCD）".to_string())?;
        let entries_total = u16_at(data, eocd + 10).ok_or("EOCD 损坏")? as usize;
        let cd_offset = u32_at(data, eocd + 16).ok_or("EOCD 损坏")? as usize;

        // 声明位置不是中央目录头时，说明打包器写错了偏移或有前置数据：找第一个 CDFH 重新定基准
        let mut pos = cd_offset;
        if data.get(pos..pos + 4) != Some(&SIG_CDFH) {
            pos = (0..data.len().saturating_sub(4))
                .find(|&i| data[i..i + 4] == SIG_CDFH)
                .ok_or("未找到 ZIP 中央目录条目")?;
        }
        let archive_offset = (pos.saturating_sub(cd_offset)) as u64;

        let mut entries = Vec::with_capacity(entries_total.min(4096));
        let mut p = pos;
        for _ in 0..entries_total {
            if data.get(p..p + 4) != Some(&SIG_CDFH) {
                break;
            }
            let method = u16_at(data, p + 10).ok_or("中央目录条目损坏")?;
            let compressed_size = u32_at(data, p + 20).ok_or("中央目录条目损坏")? as u64;
            let name_len = u16_at(data, p + 28).ok_or("中央目录条目损坏")? as usize;
            let extra_len = u16_at(data, p + 30).ok_or("中央目录条目损坏")? as usize;
            let comment_len = u16_at(data, p + 32).ok_or("中央目录条目损坏")? as usize;
            let header_offset = u32_at(data, p + 42).ok_or("中央目录条目损坏")? as u64;
            let name_bytes = data
                .get(p + 46..p + 46 + name_len)
                .ok_or("中央目录条目损坏")?;
            let name = decode_zip_name(name_bytes);
            entries.push(RawEntry {
                name,
                method,
                compressed_size,
                header_offset: (header_offset + archive_offset) as u64,
            });
            p += 46 + name_len + extra_len + comment_len;
        }
        if entries.is_empty() {
            return Err("ZIP 中没有可识别的文件条目".to_string());
        }
        Ok(RawZipIndex { entries })
    }
}

/// 按需 seek 读取条目：本地文件头(30B+名称+扩展) + 压缩数据，只碰需要的字节区间
fn extract_entry_ranged(file: &mut File, entry: &RawEntry) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(entry.header_offset))
        .map_err(|e| format!("seek 失败: {}", e))?;
    let mut lfh = [0u8; 30];
    file.read_exact(&mut lfh)
        .map_err(|e| format!("读取本地文件头失败: {}", e))?;
    if lfh[0..4] != SIG_LFH {
        return Err(format!("条目「{}」的本地文件头损坏", entry.name));
    }
    let name_len = u16_at(&lfh, 26).ok_or("本地文件头损坏")? as u64;
    let extra_len = u16_at(&lfh, 28).ok_or("本地文件头损坏")? as u64;
    file.seek(SeekFrom::Current((name_len + extra_len) as i64))
        .map_err(|e| format!("seek 失败: {}", e))?;
    let mut comp = vec![0u8; entry.compressed_size as usize];
    file.read_exact(&mut comp)
        .map_err(|_| format!("条目「{}」的数据不完整", entry.name))?;
    match entry.method {
        0 => Ok(comp),
        8 => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(&comp[..])
                .read_to_end(&mut out)
                .map_err(|e| format!("解压条目「{}」失败: {}", entry.name, e))?;
            Ok(out)
        }
        m => Err(format!("不支持的压缩方法: {}（条目「{}」）", m, entry.name)),
    }
}

