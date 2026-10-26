/* 外部插件包（.rbplugin = zip）：Rust 侧只做"基础能力"——
   安装（解包到应用数据目录 plugins/<id>/）、列举、读取包内文件、卸载（回收站）。
   插件本身是前端 TS 单文件 ESM，由前端 loader 动态加载执行；
   本模块不执行任何插件代码，全部输入（条目名/id/文件名）都做穿越校验。 */
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 插件包描述（manifest.json 解析结果，前端加载与面板展示用）
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginPkgInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// 要求的宿主插件 API 大版本
    #[serde(default = "default_api")]
    pub api: u32,
    /// 入口文件（包内相对路径）
    #[serde(default = "default_entry")]
    pub entry: String,
    /// 可接管的扩展名（小写、含点）
    #[serde(default)]
    pub extensions: Vec<String>,
    /// 安装目录（列举时填充；manifest 中忽略）
    #[serde(default)]
    pub dir: String,
}

fn default_api() -> u32 {
    1
}
fn default_entry() -> String {
    "main.js".to_string()
}

/// 当前宿主支持的插件 API 大版本
const SUPPORTED_API: u32 = 1;

pub fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?
        .join("plugins");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建插件目录: {}", e))?;
    Ok(dir)
}

/// 插件 id：小写字母/数字开头，仅含小写字母数字与 -_，≤64 字符
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// 解析并校验 manifest（id 合法、api 受支持、扩展名形如 ".png"）
fn parse_manifest(json: &str) -> Result<PluginPkgInfo, String> {
    let mut m: PluginPkgInfo =
        serde_json::from_str(json).map_err(|e| format!("manifest.json 解析失败: {}", e))?;
    m.id = m.id.trim().to_string();
    m.entry = m.entry.trim().to_string();
    if !valid_id(&m.id) {
        return Err(format!("插件 id 不合法（需小写字母数字与 - _，≤64 字符）: {}", m.id));
    }
    if m.name.trim().is_empty() {
        return Err("manifest 缺少 name".into());
    }
    if m.version.trim().is_empty() {
        return Err("manifest 缺少 version".into());
    }
    if m.api != SUPPORTED_API {
        return Err(format!(
            "插件要求宿主插件 API v{}，本版本支持 v{}",
            m.api, SUPPORTED_API
        ));
    }
    if m.entry.is_empty() {
        m.entry = default_entry();
    }
    let entry_rel = safe_rel(&m.entry).map_err(|_| format!("entry 路径不合法: {}", m.entry))?;
    if entry_rel.components().count() != 1 {
        return Err(format!("entry 必须是包根下的单文件名: {}", m.entry));
    }
    if m.extensions.is_empty() {
        return Err("manifest 未声明 extensions".into());
    }
    for ext in &m.extensions {
        let e = ext.trim().to_ascii_lowercase();
        if e.len() < 2 || e.len() > 17 || !e.starts_with('.') || !e[1..].chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("扩展名不合法（应形如 \".png\"）: {}", ext));
        }
    }
    m.extensions = m.extensions.iter().map(|e| e.trim().to_ascii_lowercase()).collect();
    Ok(m)
}

/// 读取插件目录的 manifest（manifest 损坏/不合法的目录直接跳过，不阻塞其他插件）
fn read_pkg(dir: &Path) -> Option<PluginPkgInfo> {
    let raw = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let mut m = parse_manifest(&raw).ok()?;
    m.dir = dir.to_string_lossy().to_string();
    Some(m)
}

/// 列出已安装的全部外部插件
pub fn list_plugins(app: &AppHandle) -> Result<Vec<PluginPkgInfo>, String> {
    let base = plugins_dir(app)?;
    let mut out = Vec::new();
    for item in fs::read_dir(&base).map_err(|e| format!("无法读取插件目录: {}", e))?.flatten() {
        if !item.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        // 无效 id 的目录不参与（可能是用户手放的杂物）
        let name = item.file_name().to_string_lossy().to_string();
        if !valid_id(&name) {
            continue;
        }
        if let Some(pkg) = read_pkg(&item.path()) {
            out.push(pkg);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// zip 条目名/包内文件名 → 安全相对路径：拒绝绝对路径、盘符、反斜杠与 `..` 穿越
fn safe_rel(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\\') || name.contains('\0') || name.starts_with('/') {
        return Err(format!("路径不合法: {}", name));
    }
    if name.len() > 255 {
        return Err("路径过长".into());
    }
    let p = Path::new(name);
    for comp in p.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("路径不合法: {}", name)),
        }
    }
    Ok(p.to_path_buf())
}

/// 从 .rbplugin（zip）安装：校验 manifest 后解包全部条目到 plugins/<id>/。
/// 已存在同 id 时覆盖安装（先删旧目录）。zip 解析复用自研宽容 zipfile。
pub fn install_plugin(app: &AppHandle, zip_path: &str) -> Result<PluginPkgInfo, String> {
    let entries = crate::zipfile::list_zip_files(zip_path)?;
    let manifest_raw = crate::zipfile::read_zip_entry_raw(zip_path, "manifest.json")
        .map_err(|_| "包内缺少根级 manifest.json".to_string())?;
    let m = parse_manifest(&String::from_utf8_lossy(&manifest_raw))?;
    if !entries.iter().any(|e| e == &m.entry) {
        return Err(format!("包内缺少入口文件 {}", m.entry));
    }
    let target = plugins_dir(app)?.join(&m.id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("移除旧版本失败: {}", e))?;
    }
    fs::create_dir_all(&target).map_err(|e| format!("创建插件目录失败: {}", e))?;
    for e in &entries {
        let rel = safe_rel(e)?;
        let dest = target.join(&rel);
        if e.ends_with('/') {
            fs::create_dir_all(&dest).map_err(|err| format!("创建目录失败: {}", err))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {}", err))?;
        }
        let bytes = crate::zipfile::read_zip_entry_raw(zip_path, e)?;
        fs::write(&dest, &bytes).map_err(|err| format!("写出文件失败: {}", err))?;
    }
    let mut installed = m;
    installed.dir = target.to_string_lossy().to_string();
    Ok(installed)
}

/// 卸载：插件目录移入系统回收站（可恢复）；回收站失败时回退直接删除
pub fn uninstall_plugin(app: &AppHandle, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("插件 id 不合法: {}", id));
    }
    let target = plugins_dir(app)?.join(id);
    if !target.is_dir() {
        return Err(format!("未安装插件: {}", id));
    }
    trash::delete(&target).or_else(|_| fs::remove_dir_all(&target)).map_err(|e| format!("卸载失败: {}", e))
}

/// 读取插件包内文件字节（入口 main.js 与 assets 资源）。
/// canonicalize 双重校验，确保走不出插件目录。
pub fn read_plugin_file(app: &AppHandle, id: &str, name: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err(format!("插件 id 不合法: {}", id));
    }
    let base = plugins_dir(app)?;
    let path = base.join(id).join(safe_rel(name)?);
    let canon = path.canonicalize().map_err(|_| format!("包内文件不存在: {}", name))?;
    let base_canon = base.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&base_canon) {
        return Err(format!("路径越界: {}", name));
    }
    fs::read(&canon).map_err(|e| format!("读取失败: {}", e))
}
