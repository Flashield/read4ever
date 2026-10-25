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

/// 持久化数据结构：设置、书签、历史、收藏、关键词组
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreData {
    pub settings: Settings,
    pub bookmarks: Vec<Bookmark>,
    pub history: Vec<HistoryEntry>,
    pub bookshelf: Vec<BookshelfItem>,
    #[serde(default)]
    pub keyword_groups: Vec<KeywordGroup>,
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
            scroll_speed: 3.0,
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
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("readbook.json"))
}

pub fn load_store(app: &AppHandle) -> StoreData {
    match store_path(app) {
        Some(p) if p.exists() => {
            let data = fs::read_to_string(&p).unwrap_or_default();
            serde_json::from_str(&data).unwrap_or_default()
        }
        _ => StoreData::default(),
    }
}

pub fn save_store(app: &AppHandle, data: &StoreData) -> Result<(), String> {
    let p = store_path(app).ok_or("无法获取数据目录")?;
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())
}
