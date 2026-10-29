use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
            plugins: std::collections::HashMap::new(),
            plugin_settings: std::collections::HashMap::new(),
            folder_tab: String::new(),
            bookshelf_active_id: String::new(),
            keep_awake: true,
            natural_sort: true,
            open_in_new_tab: true,
            tab_switch_playback: "pause".to_string(),
            tab_limit: 20,
            tabs: Vec::new(),
            active_tab_index: 0,
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
    Some(dir.join("readbook.json"))
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
            store
        }
        _ => StoreData::default(),
    }
}

pub fn save_store(app: &AppHandle, data: &StoreData) -> Result<(), String> {
    let p = store_path(app).ok_or("无法获取数据目录")?;
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS_JSON: &str = r#""settings": {
        "themeName": "白纸", "customThemes": [], "fontFamily": "SimSun",
        "fontSize": 18, "lineSpacing": 1.8, "scrollSpeed": 135,
        "scrollMode": "continuous", "pageInterval": 10, "displayMode": "auto",
        "dualPage": false, "lastFilePath": "", "lastScroll": 0, "autoRestore": true
    }"#;

    /// 旧版 readbook.json（扁平 bookshelf、条目无 tags、无 bookshelves）
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
}
