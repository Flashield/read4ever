/* SMB 远程浏览（smb2 crate，纯 Rust，tokio 异步）。
   spike 结论（2026-10-26，smb2 0.35 源码核实）：
   - 纯 Rust 无 FFI：依赖树已隔离验证 aarch64-apple-ios-sim 目标编译通过（iOS 方案门禁）；
     主工程 iOS 交叉检查卡在 objc2（Tauri iOS 栈需 Xcode），与 smb2 无关
   - 访客登录 = username 留空（或 "Guest"）；消费侧路径分隔符一律 "/"，
     名字里的 Windows 非法字符由 crate 自动做私有区映射
   - 目录条目自带 size/is_directory/modified（FileTime::to_system_time 换算）
   - 区间读：Arc<Tree>::open_file_reader(conn, path) → FileReader::read_at(&self, off, len)
   - Connection 可 Clone，克隆共享同一 SMB 会话；auto_reconnect 断线原地重拨重认证
   规范路径：smb://<服务器id>/<share>/<相对路径>，zip 条目再追加 "::条目名"。
   凭证表由前端启动/增删后经 smb_put_servers 推入（避免读到防抖 save_store 的旧数据）。
   远程侧只读：不调用 delete/rename/write 类接口。 */

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use smb2::client::connection::Connection;
use smb2::pack::FileTime;
use smb2::{ClientConfig, SmbClient, Tree};

use crate::store::SmbServer;

/// 单个网络操作的总超时（连接建立另有 ClientConfig.timeout）
const OP_TIMEOUT: Duration = Duration::from_secs(15);
/// 流式下载的块大小
const CHUNK: u64 = 256 * 1024;

/// 单服务器会话：client 保活（断线重连由它负责），tree 克隆给各操作，conn 克隆分发。
/// Connection 克隆共享同一 SMB 会话，操作间无需加锁串行。
/// cfg 是建会话时的配置快照——put_servers 时与当前表比对，不一致即失效重建。
struct SmbSession {
    cfg: SmbServer,
    _client: SmbClient,
    tree: Arc<Tree>,
    conn: Connection,
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
    // Tree 的方法要 &mut Connection：从 client 拿克隆（与 tree 同源，共享会话）
    let conn = client.connection().clone();
    let session = Arc::new(SmbSession {
        cfg,
        _client: client,
        conn,
        tree: Arc::new(tree),
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

/// 丢弃某服务器的会话（面板「刷新」用，强制重连）
pub fn drop_session(id: &str) {
    sessions().write().unwrap().remove(id);
}

/// 测试连接：连服务器 + 连共享 + 列共享根，全通才返回成功
pub async fn test_connection(cfg: &SmbServer) -> Result<String, String> {
    let addr = addr_of(cfg);
    let fut = async {
        let mut client = SmbClient::connect(config_of(cfg))
            .await
            .map_err(|e| format!("无法连接 {}: {}", addr, e))?;
        let tree = client
            .connect_share(&cfg.share)
            .await
            .map_err(|e| format!("无法打开共享 \\\\{}\\{}: {}", cfg.host, cfg.share, e))?;
        let conn = client.connection().clone();
        let entries = tree
            .list_directory(&mut conn.clone(), "")
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

/// 列出 share 内单层目录（smb://…/share[/子路径]）：目录优先、名称排序，跳 . .. 隐藏项
pub async fn list_dir(path: &str, cache_dir: &Path) -> Result<Vec<SmbFileEntry>, String> {
    let (cfg, rel) = resolve(path)?;
    let ses = session_for(&cfg.id).await?;
    // list_directory 的目录参数带尾斜杠（share 根传空串）
    let list_path = if rel.is_empty() {
        String::new()
    } else {
        format!("{}/", rel)
    };
    let entries = with_timeout("列目录", ses.tree.list_directory(&mut ses.conn.clone(), &list_path))
        .await?
        .map_err(|e| format!("无法读取远程目录 {}: {}", path, e))?;
    let parent = path.split("::").next().unwrap_or(path).trim_end_matches('/');
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
        _ => a.entry.name.to_lowercase().cmp(&b.entry.name.to_lowercase()),
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
    let info = with_timeout("访问远程文件", ses.tree.stat(&mut ses.conn.clone(), &rel))
        .await?
        .map_err(|e| format!("无法访问 {}: {}", path, e))?;
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

/// 缓存远程文件：已新鲜直接复用；否则 256KB 块流式下载，.part → rename 原子落盘
pub async fn cache_file(path: &str, cache_dir: &Path) -> Result<PathBuf, String> {
    let (cfg, rel) = resolve(path)?;
    if rel.is_empty() {
        return Err("共享根目录无需缓存".into());
    }
    let ses = session_for(&cfg.id).await?;
    let info = with_timeout("访问远程文件", ses.tree.stat(&mut ses.conn.clone(), &rel))
        .await?
        .map_err(|e| format!("无法访问 {}: {}", path, e))?;
    if info.is_directory {
        return Err("目录无需缓存".into());
    }
    let (size, mtime) = (info.size, mtime_ms(info.modified));
    let key = key_of(path);
    let bin = cache_dir.join(format!("{}.bin", key));
    if bin.exists() && fresh_meta(cache_dir, path, size, mtime) {
        return Ok(bin); // 已新鲜，免下载
    }
    let reader = with_timeout(
        "打开远程文件",
        ses.tree.clone().open_file_reader(ses.conn.clone(), &rel),
    )
    .await?
    .map_err(|e| format!("无法打开远程文件 {}: {}", path, e))?;
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    let part = cache_dir.join(format!("{}.part", key));
    let mut out = std::fs::File::create(&part).map_err(|e| format!("写缓存失败: {}", e))?;
    let mut off = 0u64;
    while off < size {
        let len = CHUNK.min(size - off);
        let chunk = with_timeout("下载数据", reader.read_at(off, len))
            .await?
            .map_err(|e| {
                let _ = std::fs::remove_file(&part);
                format!("下载 {} 失败: {}", path, e)
            })?;
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
