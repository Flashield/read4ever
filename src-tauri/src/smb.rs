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
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use smb2::client::connection::Connection;
use smb2::{ClientConfig, SmbClient, Tree};

use crate::store::SmbServer;

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
