use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use sha2::Digest;

/// store 文件名（store_path 与启动期 read_allow_multiple 必须一致）
const STORE_FILE: &str = "read4ever.json";

/// 自定义配色方案
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub name: String,
    pub bg: String,
    pub text: String,
    pub font_family: String,
    pub font_size: f64,
    pub line_spacing: f64,
}

/// 关键词组：多个关键词组成一组，检索/统计以组为单位
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeywordGroup {
    pub id: String,
    pub name: String,
    pub keywords: Vec<String>,
}

/// SMB 远程服务器配置（远程浏览用）。username 为空 = 访客登录。
/// id 是稳定短 id，规范路径 smb://<id>/share/… 以它引用本配置。
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmbServer {
    pub id: String,
    pub name: String,
    /// 主机名或 IP（可带 :端口，默认 445）
    pub host: String,
    /// 共享名（不含斜杠）
    pub share: String,
    #[serde(default)]
    pub workgroup: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

/// 持久化数据结构：设置、书签、历史、收藏、关键词组
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreData {
    pub settings: Settings,
    pub bookmarks: Vec<Bookmark>,
    pub history: Vec<HistoryEntry>,
    /// 旧版单书架扁平列表：仅反序列化兼容，加载时迁入 bookshelves 后清空、不再写出
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bookshelf: Vec<BookshelfItem>,
    #[serde(default)]
    pub bookshelves: Vec<Bookshelf>,
    #[serde(default)]
    pub keyword_groups: Vec<KeywordGroup>,
    #[serde(default)]
    pub smb_servers: Vec<SmbServer>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabDescriptor {
    pub path: String,
    pub ratio: f64,
}

fn default_tab_limit() -> u32 {
    20
}

fn default_pause() -> String {
    "pause".to_string()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme_name: String,
    pub custom_themes: Vec<CustomTheme>,
    /// 未保存为方案时的自定义背景/文字颜色（theme_name == "自定义"）
    #[serde(default)]
    pub custom_bg: String,
    #[serde(default)]
    pub custom_text: String,
    pub font_family: String,
    pub font_size: f64,
    pub line_spacing: f64,
    pub scroll_speed: f64,
    pub scroll_mode: String, // "continuous" | "page"
    pub page_interval: f64,  // 秒
    pub display_mode: String, // "auto" | "simplified" | "traditional"
    pub dual_page: bool,
    pub last_file_path: String,
    pub last_scroll: f64,
    pub auto_restore: bool,
    /// 当前使用的关键词组 id
    #[serde(default)]
    pub active_keyword_group: String,
    /// 上次打开的文件夹（文件夹侧栏恢复用）
    #[serde(default)]
    pub last_folder_path: String,
    /// 启动时自动打开文件夹侧栏
    #[serde(default = "default_true")]
    pub folder_auto_open: bool,
    /// 文件夹侧栏文件列表是否包含子目录
    #[serde(default)]
    pub folder_list_recursive: bool,
    /// 远程列表是否含子目录
    #[serde(default)]
    pub smb_list_recursive: bool,
    /// 远程递归下钻层数（1–5，0=不限）
    #[serde(default)]
    pub smb_list_depth: u32,
    /// 插件启用状态（插件 id → 是否启用；未列出的默认启用）
    #[serde(default)]
    pub plugins: std::collections::HashMap<String, bool>,
    /// 插件固定设置（插件 id → 设置键值）
    #[serde(default)]
    pub plugin_settings: std::collections::HashMap<String, std::collections::HashMap<String, serde_json::Value>>,
    /// 文件夹侧栏当前标签："" 本地 / "smb" 远程
    #[serde(default)]
    pub folder_tab: String,
    /// 书架面板当前书架 id（失效时前端回退第一个）
    #[serde(default)]
    pub bookshelf_active_id: String,
    /// 滚屏/播放时保持屏幕常亮
    #[serde(default = "default_true")]
    pub keep_awake: bool,
    /// 播放/滚屏开始时自动进入无边框模式
    #[serde(default)]
    pub play_borderless: bool,
    /// 文件名自然排序
    #[serde(default = "default_true")]
    pub natural_sort: bool,
    /// 手动打开文件默认新标签页
    #[serde(default = "default_true")]
    pub open_in_new_tab: bool,
    /// 切换标签页时后台媒体："pause" | "continue"
    #[serde(default = "default_pause")]
    pub tab_switch_playback: String,
    /// 标签页数量上限
    #[serde(default = "default_tab_limit")]
    pub tab_limit: u32,
    /// 启动恢复用标签页描述（惰性重建）
    #[serde(default)]
    pub tabs: Vec<TabDescriptor>,
    /// 启动恢复时激活的 tab 下标
    #[serde(default)]
    pub active_tab_index: u32,
    /// 允许同时运行多个程序实例（重启后生效；缺失/损坏按单实例兜底）
    #[serde(default)]
    pub allow_multiple_instances: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme_name: "白纸".to_string(),
            custom_themes: Vec::new(),
            custom_bg: "#ffffff".to_string(),
            custom_text: "#000000".to_string(),
            font_family: "SimSun".to_string(),
            font_size: 18.0,
            line_spacing: 1.8,
            scroll_speed: 135.0, // 滚屏基准速度（像素/秒）
            scroll_mode: "continuous".to_string(),
            page_interval: 10.0,
            display_mode: "auto".to_string(),
            dual_page: false,
            last_file_path: String::new(),
            last_scroll: 0.0,
            auto_restore: true,
            active_keyword_group: String::new(),
            last_folder_path: String::new(),
            folder_auto_open: true,
            folder_list_recursive: false,
            smb_list_recursive: false,
            smb_list_depth: 0,
            plugins: std::collections::HashMap::new(),
            plugin_settings: std::collections::HashMap::new(),
            folder_tab: String::new(),
            bookshelf_active_id: String::new(),
            keep_awake: true,
            play_borderless: false,
            natural_sort: true,
            open_in_new_tab: true,
            tab_switch_playback: "pause".to_string(),
            tab_limit: 20,
            tabs: Vec::new(),
            active_tab_index: 0,
            allow_multiple_instances: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub file_path: String,
    pub position: f64, // scroll percentage 0..1
    pub description: String,
    pub created: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub file_path: String,
    pub file_name: String,
    pub position: f64,
    pub encoding: String,
    pub last_read: String,
    pub read_seconds: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookshelfItem {
    pub file_path: String,
    pub name: String,
    pub added: String,
    /// 标签（书架面板快速筛选用）
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 收藏书架：多书架，条目嵌套归属
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bookshelf {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub items: Vec<BookshelfItem>,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(STORE_FILE))
}

/// 旧版扁平收藏列表迁入默认书架（幂等：新列表非空时丢弃旧列表）
fn migrate_legacy_bookshelf(data: &mut StoreData) {
    if data.bookshelves.is_empty() && !data.bookshelf.is_empty() {
        data.bookshelves.push(Bookshelf {
            id: "shelf-default".to_string(),
            name: "默认书架".to_string(),
            items: std::mem::take(&mut data.bookshelf),
        });
    } else if !data.bookshelf.is_empty() {
        data.bookshelf.clear();
    }
}

pub fn load_store(app: &AppHandle) -> StoreData {
    match store_path(app) {
        Some(p) if p.exists() => {
            let data = fs::read_to_string(&p).unwrap_or_default();
            let mut store: StoreData = serde_json::from_str(&data).unwrap_or_default();
            migrate_legacy_bookshelf(&mut store);
            // 读取边界：密码解密回明文（解不开的值原样保留），与 save_store 的加密边界对称
            decrypt_store_passwords(store)
        }
        _ => StoreData::default(),
    }
}

/// 密码落盘加密密钥根（应用内置常量）。防直接肉眼查看，不防有意逆向——
/// 约定见 docs/spec/SMB含子目录与密码加密方案.md
const PW_SECRET: &[u8] = b"Read4Ever/smb-password/v1";
/// 密文前缀：enc1: + base64(salt[16] ‖ nonce[12] ‖ AES-256-GCM 密文)
const PW_PREFIX: &str = "enc1:";

/// 由内置常量与随机 salt 派生 AES-256 密钥
fn derive_key(salt: &[u8; 16]) -> Aes256Gcm {
    let mut h = sha2::Sha256::new();
    h.update(PW_SECRET);
    h.update(salt);
    let digest = h.finalize();
    Aes256Gcm::new_from_slice(&digest).expect("SHA-256 输出必为 32 字节")
}

/// 落盘前加密：非空且未带前缀的密码 → "enc1:" + base64(salt‖nonce‖密文)。
/// 空密码原样返回；已带前缀原样返回（避免二次包裹；真实密码恰以 enc1: 开头时
/// 解密失败也会原样保留，两端行为一致）
fn encrypt_password(plain: &str) -> String {
    if plain.is_empty() || plain.starts_with(PW_PREFIX) {
        return plain.to_string();
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let cipher = derive_key(&salt);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plain.as_bytes())
        .expect("AES-GCM 加密失败");
    let mut buf = Vec::with_capacity(16 + 12 + ct.len());
    buf.extend_from_slice(&salt);
    buf.extend_from_slice(&nonce);
    buf.extend_from_slice(&ct);
    format!("{}{}", PW_PREFIX, BASE64_STANDARD.encode(buf))
}

/// 读取后解密：enc1: 前缀的值尝试解密，任何失败（非法 base64 / tag 不符 /
/// 长度不足 / 非法 UTF-8）原样返回——兼容手工改坏的文件与恰以 enc1: 开头的明文
fn decrypt_password(val: &str) -> String {
    let Some(rest) = val.strip_prefix(PW_PREFIX) else {
        return val.to_string(); // 旧明文 / 空密码
    };
    let Ok(buf) = BASE64_STANDARD.decode(rest) else {
        return val.to_string();
    };
    if buf.len() < 16 + 12 + 16 {
        return val.to_string(); // salt+nonce+密文（含 tag）最短长度
    }
    let (salt, rest) = buf.split_at(16);
    let (nonce, ct) = rest.split_at(12);
    let mut salt_arr = [0u8; 16];
    salt_arr.copy_from_slice(salt);
    let pt = derive_key(&salt_arr).decrypt(Nonce::from_slice(nonce), ct);
    match pt {
        Ok(p) => String::from_utf8(p).unwrap_or_else(|_| val.to_string()),
        Err(_) => val.to_string(),
    }
}

/// save_store 落盘边界：全部 SMB 服务器密码加密（旧明文下次保存自动升级为密文）
fn encrypt_store_passwords(mut data: StoreData) -> StoreData {
    for s in &mut data.smb_servers {
        s.password = encrypt_password(&s.password);
    }
    data
}

/// load_store 读取边界：全部 SMB 服务器密码解密回明文
fn decrypt_store_passwords(mut data: StoreData) -> StoreData {
    for s in &mut data.smb_servers {
        s.password = decrypt_password(&s.password);
    }
    data
}

pub fn save_store(app: &AppHandle, data: &StoreData) -> Result<(), String> {
    let p = store_path(app).ok_or("无法获取数据目录")?;
    // 落盘边界：密码加密写出（内存 store 不动；旧明文读入后下次保存自动升级为密文）
    let json = serde_json::to_string_pretty(&encrypt_store_passwords(data.clone()))
        .map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())
}

/// 无 AppHandle 时复算 app_data_dir：直用 tauri 同源的 dirs::data_dir()（数据目录 + identifier），
/// 必须与 store_path(app) 落到同一文件。
/// 注意：若 tauri.conf.json 将来配置 appDirectoriesOverride，此处会失配（当前未配置）。
fn app_data_dir_no_handle(identifier: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(identifier))
}

/// 从 store JSON 读 allowMultipleInstances；缺失/损坏/类型不符一律 false（单实例兜底）
fn parse_allow_multiple(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("settings")?.get("allowMultipleInstances")?.as_bool())
        .unwrap_or(false)
}

/// 启动早期（尚无 AppHandle）读多开设置，决定是否注册单实例插件
pub fn read_allow_multiple(identifier: &str) -> bool {
    app_data_dir_no_handle(identifier)
        .and_then(|dir| fs::read_to_string(dir.join(STORE_FILE)).ok())
        .map(|json| parse_allow_multiple(&json))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// parse_allow_multiple：true / false / 字段缺失 / 坏 JSON / 类型不符 → 仅显式 true 才多开
    #[test]
    fn parse_allow_multiple_variants() {
        assert!(parse_allow_multiple(r#"{"settings":{"allowMultipleInstances":true}}"#));
        assert!(!parse_allow_multiple(r#"{"settings":{"allowMultipleInstances":false}}"#));
        assert!(!parse_allow_multiple(r#"{"settings":{}}"#));
        assert!(!parse_allow_multiple(r#"{}"#));
        assert!(!parse_allow_multiple("not json"));
        assert!(!parse_allow_multiple(r#"{"settings":{"allowMultipleInstances":"yes"}}"#));
    }

    /// 旧版 store（无该字段）解析后默认 false（单实例兜底），serde default 生效
    #[test]
    fn settings_without_allow_multiple_default_false() {
        let json = format!(r#"{{ {}, "bookmarks": [], "history": [] }}"#, SETTINGS_JSON);
        let store: StoreData = serde_json::from_str(&json).unwrap();
        assert!(!store.settings.allow_multiple_instances);
    }

    const SETTINGS_JSON: &str = r#""settings": {
        "themeName": "白纸", "customThemes": [], "fontFamily": "SimSun",
        "fontSize": 18, "lineSpacing": 1.8, "scrollSpeed": 135,
        "scrollMode": "continuous", "pageInterval": 10, "displayMode": "auto",
        "dualPage": false, "lastFilePath": "", "lastScroll": 0, "autoRestore": true
    }"#;

    /// 旧版 store（扁平 bookshelf、条目无 tags、无 bookshelves）
    /// → 迁入「默认书架」，tags 补空，序列化只写新字段
    #[test]
    fn legacy_flat_bookshelf_migrates_to_default_shelf() {
        let json = format!(
            r#"{{ {}, "bookmarks": [], "history": [],
                "bookshelf": [
                    {{ "filePath": "C:\\b\\a.txt", "name": "a", "added": "2026-01-01T00:00:00Z" }},
                    {{ "filePath": "C:\\b\\b.txt", "name": "b", "added": "2026-01-02T00:00:00Z" }}
                ] }}"#,
            SETTINGS_JSON
        );
        let mut store: StoreData = serde_json::from_str(&json).unwrap();
        migrate_legacy_bookshelf(&mut store);
        assert_eq!(store.bookshelves.len(), 1);
        let shelf = &store.bookshelves[0];
        assert_eq!(shelf.id, "shelf-default");
        assert_eq!(shelf.name, "默认书架");
        assert_eq!(shelf.items.len(), 2);
        assert_eq!(shelf.items[0].file_path, "C:\\b\\a.txt");
        assert!(shelf.items.iter().all(|i| i.tags.is_empty()));
        assert!(store.bookshelf.is_empty()); // 旧字段清空 → 序列化时 skip
        let out = serde_json::to_string(&store).unwrap();
        assert!(!out.contains("\"bookshelf\":"), "旧字段不应再写出: {out}");
        assert!(out.contains("\"bookshelves\":"));
        assert!(out.contains("\"tags\":[]"));
    }

    /// 新格式数据：迁移不生效（幂等），缺 tags 字段补空，round-trip 不丢字段
    #[test]
    fn new_format_roundtrip_and_default_tags() {
        let json = format!(
            r#"{{ {}, "bookmarks": [], "history": [],
                "bookshelves": [
                    {{ "id": "s1", "name": "小说", "items": [
                        {{ "filePath": "/x/1.txt", "name": "1", "added": "2026-01-01T00:00:00Z", "tags": ["科幻", "长篇"] }},
                        {{ "filePath": "/x/2.txt", "name": "2", "added": "2026-01-02T00:00:00Z" }}
                    ] }},
                    {{ "id": "s2", "name": "资料", "items": [] }}
                ] }}"#,
            SETTINGS_JSON
        );
        let mut store: StoreData = serde_json::from_str(&json).unwrap();
        migrate_legacy_bookshelf(&mut store);
        assert_eq!(store.bookshelves.len(), 2); // 不变
        assert_eq!(store.bookshelves[0].items.len(), 2);
        assert_eq!(store.bookshelves[0].items[0].tags, vec!["科幻", "长篇"]);
        assert!(store.bookshelves[0].items[1].tags.is_empty()); // 缺字段 → default
        // round-trip
        let out = serde_json::to_string(&store).unwrap();
        let back: StoreData = serde_json::from_str(&out).unwrap();
        assert_eq!(back.bookshelves[0].items[0].tags, vec!["科幻", "长篇"]);
        assert_eq!(back.bookshelves.len(), 2);
    }

    /// 密码落盘加密：roundtrip、随机密文、旧明文/空密码直通、坏密文原样保留
    #[test]
    fn password_encrypt_decrypt_variants() {
        // roundtrip（含中文）
        let enc = encrypt_password("s3cret密码");
        assert!(enc.starts_with("enc1:"));
        assert_ne!(enc, "s3cret密码");
        assert_eq!(decrypt_password(&enc), "s3cret密码");
        // 同一明文两次加密密文不同（随机 salt+nonce）
        assert_ne!(enc, encrypt_password("s3cret密码"));
        // 旧明文 / 空密码 / 已带前缀值原样直通
        assert_eq!(decrypt_password("legacy"), "legacy");
        assert_eq!(decrypt_password(""), "");
        assert_eq!(encrypt_password(""), "");
        assert_eq!(encrypt_password("enc1:abc"), "enc1:abc");
        // base64 非法 → 原样保留
        assert_eq!(decrypt_password("enc1:不是base64!!"), "enc1:不是base64!!");
        // 合法 base64 但长度不足（< salt+nonce+tag）→ 原样保留
        assert_eq!(decrypt_password("enc1:AAAA"), "enc1:AAAA");
        // 密文被篡改（tag 校验失败）→ 原样保留
        let good = encrypt_password("abc123");
        let mut broken = good.clone();
        broken.replace_range(broken.len() - 4.., "AAAA");
        assert_ne!(broken, good);
        assert_eq!(decrypt_password(&broken), broken);
    }

    /// save/load 边界：加密后的 JSON 不含明文，读回还原
    #[test]
    fn store_password_roundtrip_through_boundary() {
        let mut data = StoreData::default();
        data.smb_servers.push(SmbServer {
            id: "s1".to_string(),
            name: "测试".to_string(),
            host: "nas.local".to_string(),
            share: "books".to_string(),
            workgroup: String::new(),
            username: "user".to_string(),
            password: "密123abc".to_string(),
        });
        let saved = encrypt_store_passwords(data.clone());
        let json = serde_json::to_string(&saved).unwrap();
        assert!(!json.contains("密123abc"), "落盘 JSON 不得含明文密码: {json}");
        assert!(json.contains("enc1:"));
        let loaded = decrypt_store_passwords(saved);
        assert_eq!(loaded.smb_servers[0].password, "密123abc");
    }
}
