use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use crate::encoding::encode_text;
use crate::plugin_pkg;
use crate::reorder::{looks_like_hard_lines, reorder_text};
use crate::seqfile::{find_next_file, find_prev_file};
use crate::smb;
use crate::store::{self, StoreData};
use crate::zipfile::{is_zip_file, read_text_file, read_zip_entry as read_zip_entry_inner};

/// 读取文件返回的结构
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
    pub file_name: String,
    pub file_path: String,
    pub is_hard_lines: bool,
    /// 附加提示（如 SMB 离线兜底打开时说明内容可能过期）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 打开文本文件（通过前端 dialog 拿到路径后调用）。
/// encoding 不为 None 时按指定编码解码（手动重新打开场景）。
#[tauri::command]
pub async fn open_text_file(
    app: AppHandle,
    path: String,
    encoding: Option<String>,
) -> Result<FileContent, String> {
    // smb 分发放在 is_zip_file 之前：File::open("smb://…") 的报错有误导性
    if smb::is_smb_path(&path) {
        return smb::open_text(&path, &smb_cache_dir(&app)?, encoding.as_deref()).await;
    }
    if is_zip_file(&path) {
        return Err("这是一个 zip 文件，请使用 open_zip_file".into());
    }
    let (content, enc) = read_text_file(&path, encoding.as_deref())?;
    let file_name = PathBuf::from(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let hard = looks_like_hard_lines(&content);
    Ok(FileContent {
        content,
        encoding: enc.to_string(),
        file_name,
        file_path: path,
        is_hard_lines: hard,
        note: None,
    })
}

/// 打开 zip，返回内部全部文件条目（类型过滤由前端按插件能力决定）
#[tauri::command]
pub fn open_zip_file(path: String) -> Result<Vec<String>, String> {
    crate::zipfile::list_zip_files(&path)
}

/// 读取磁盘文件原始字节（二进制插件用；前端 invoke 得到 ArrayBuffer）
#[tauri::command]
pub async fn read_file_bytes(app: AppHandle, path: String) -> Result<Response, String> {
    if smb::is_smb_path(&path) {
        let bytes = smb::read_all(&path).await?;
        return Ok(Response::new(bytes));
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(Response::new(bytes))
}

/// 读取 zip 内条目原始字节（二进制插件用）
#[tauri::command]
pub fn read_zip_entry_bytes(path: String, entry_name: String) -> Result<Response, String> {
    let bytes = crate::zipfile::read_zip_entry_raw(&path, &entry_name)?;
    Ok(Response::new(bytes))
}

/// 读取 zip 内指定条目。encoding 不为 None 时按指定编码解码。
#[tauri::command]
pub fn read_zip_entry(
    path: String,
    entry_name: String,
    encoding: Option<String>,
) -> Result<FileContent, String> {
    let (content, enc) = read_zip_entry_inner(&path, &entry_name, encoding.as_deref())?;
    let hard = looks_like_hard_lines(&content);
    let file_path = format!("{}::{}", path, entry_name);
    Ok(FileContent {
        content,
        encoding: enc.to_string(),
        file_name: entry_name,
        file_path,
        is_hard_lines: hard,
        note: None,
    })
}

/// 保存文本到文件（另存为）
#[tauri::command]
pub fn save_text_file(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes = encode_text(&content, &encoding);
    fs::write(&path, &bytes).map_err(|e| format!("保存失败: {}", e))
}

/// 局部编辑保存：将修改后的完整内容写回原文件
#[tauri::command]
pub fn edit_save(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes = encode_text(&content, &encoding);
    fs::write(&path, &bytes).map_err(|e| format!("编辑保存失败: {}", e))
}

/// 重新排版
#[tauri::command]
pub fn reorder(content: String) -> String {
    reorder_text(&content)
}

/// 按序号找下一个文件
#[tauri::command]
pub fn find_next(path: String) -> Option<String> {
    find_next_file(&path)
}

/// 按序号找上一个文件
#[tauri::command]
pub fn find_prev(path: String) -> Option<String> {
    find_prev_file(&path)
}

/// 加载持久化数据
#[tauri::command]
pub fn load_store(app: AppHandle) -> StoreData {
    store::load_store(&app)
}

/// 保存持久化数据
#[tauri::command]
pub fn save_store(app: AppHandle, data: StoreData) -> Result<(), String> {
    store::save_store(&app, &data)
}

/// 设置窗口标题
#[tauri::command]
pub fn set_window_title(app: AppHandle, title: String) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&title);
    }
}

/// 最小化到托盘（隐藏窗口）
#[tauri::command]
pub fn hide_to_tray(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 从托盘恢复
#[tauri::command]
pub fn show_from_tray(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 退出程序
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/* ========== 文件夹浏览与文件操作 ========== */

/// 目录条目（文件夹侧栏用）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64, // 毫秒时间戳
}

/// 列出单层目录：目录优先、按名称排序，跳过隐藏文件。
/// smb:// 路径分发到远程实现（插件 listContainer 由此免改获得 SMB 能力），
/// 远程条目的 cached 标记在此丢弃——带标记的列表走 smb_list_dir。
#[tauri::command]
pub async fn list_dir(app: AppHandle, path: String) -> Result<Vec<FileEntry>, String> {
    if smb::is_smb_path(&path) {
        let entries = smb::list_dir(&path, &smb_cache_dir(&app)?).await?;
        return Ok(entries.into_iter().map(|e| e.entry).collect());
    }
    let rd = fs::read_dir(&path).map_err(|e| format!("无法读取目录 {}: {}", path, e))?;
    let mut entries: Vec<FileEntry> = Vec::new();
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = item.file_type() else { continue };
        let Ok(md) = item.metadata() else { continue };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(FileEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir: ft.is_dir(),
            size: if ft.is_dir() { 0 } else { md.len() },
            mtime,
        });
    }
    entries.sort_by(|a, b| match (b.is_dir, a.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// 删除进系统回收站（可从回收站恢复）
#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("删除失败: {}", e))
}

/// 目标目录内生成不重名的路径：name.txt → name(1).txt → name(2).txt …
fn unique_child(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s))
        .unwrap_or_default();
    for i in 1..1000u32 {
        let cand = dir.join(format!("{}({}){}", stem, i, ext));
        if !cand.exists() {
            return cand;
        }
    }
    candidate
}

fn has_invalid_name_char(name: &str) -> bool {
    name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':')
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for item in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let t = item.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(item.file_name());
        if t.is_dir() {
            copy_dir_all(&item.path(), &target)?;
        } else {
            fs::copy(item.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 移动文件/目录到目标目录（归档）。跨盘 rename 失败时回退复制+删除，返回新路径
#[tauri::command]
pub fn move_path(from: String, to_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&from);
    let name = src
        .file_name()
        .ok_or("路径缺少文件名")?
        .to_string_lossy()
        .to_string();
    let dest = unique_child(Path::new(&to_dir), &name);
    if dest.exists() {
        return Err("目标目录已存在同名文件".into());
    }
    fs::rename(&src, &dest)
        .or_else(|_| -> Result<(), String> {
            if src.is_dir() {
                copy_dir_all(&src, &dest)?;
                fs::remove_dir_all(&src).map_err(|e| format!("删除源目录失败: {}", e))?;
            } else {
                fs::copy(&src, &dest).map_err(|e| format!("复制失败: {}", e))?;
                fs::remove_file(&src).map_err(|e| format!("删除源文件失败: {}", e))?;
            }
            Ok(())
        })
        .map_err(|e| format!("移动失败: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// 同目录重命名，返回新路径
#[tauri::command]
pub fn rename_path(from: String, new_name: String) -> Result<String, String> {
    let new_name = new_name.trim();
    if has_invalid_name_char(new_name) {
        return Err("名称不能为空，且不能包含 / \\ : 字符".into());
    }
    let src = PathBuf::from(&from);
    let parent = src.parent().ok_or("路径缺少父目录")?;
    let dest = unique_child(parent, new_name);
    fs::rename(&src, &dest).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// 在目录下新建文件夹，返回新路径
#[tauri::command]
pub fn make_dir(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if has_invalid_name_char(name) {
        return Err("名称不能为空，且不能包含 / \\ : 字符".into());
    }
    let dest = unique_child(Path::new(&parent), name);
    fs::create_dir_all(&dest).map_err(|e| format!("创建失败: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/* ========== 外部插件包（.rbplugin）基础能力 ========== */

/// 列出已安装的外部插件（应用数据目录 plugins/ 下各包的 manifest）
#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<Vec<plugin_pkg::PluginPkgInfo>, String> {
    plugin_pkg::list_plugins(&app)
}

/// 从 .rbplugin（zip）安装插件（覆盖旧版），返回包信息
#[tauri::command]
pub fn install_plugin(app: AppHandle, zip_path: String) -> Result<plugin_pkg::PluginPkgInfo, String> {
    plugin_pkg::install_plugin(&app, &zip_path)
}

/// 卸载插件（目录移入回收站）
#[tauri::command]
pub fn uninstall_plugin(app: AppHandle, id: String) -> Result<(), String> {
    plugin_pkg::uninstall_plugin(&app, &id)
}

/// 读取插件包内文件字节（入口 main.js 与 assets 资源；禁止走出插件目录）
#[tauri::command]
pub fn read_plugin_file(app: AppHandle, id: String, name: String) -> Result<Response, String> {
    let bytes = plugin_pkg::read_plugin_file(&app, &id, &name)?;
    Ok(Response::new(bytes))
}

/* ========== SMB 远程浏览 ========== */

/// 前端启动/增删服务器后推入凭证表（后端会话失效判断的依据）
#[tauri::command]
pub async fn smb_put_servers(servers: Vec<store::SmbServer>) -> Result<(), String> {
    smb::put_servers(servers);
    Ok(())
}

/// 测试连接：连服务器 + 连共享 + 列共享根，成功返回摘要串
#[tauri::command]
pub async fn smb_test_connection(server: store::SmbServer) -> Result<String, String> {
    smb::test_connection(&server).await
}

/// SMB 本地缓存目录：app_cache_dir()/smb/
fn smb_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join("smb"))
        .map_err(|e| format!("无法定位缓存目录: {}", e))
}

/// 远程目录列表（FileEntry + cached 标记，远程面板用）
#[tauri::command]
pub async fn smb_list_dir(app: AppHandle, path: String) -> Result<Vec<smb::SmbFileEntry>, String> {
    smb::list_dir(&path, &smb_cache_dir(&app)?).await
}

/// 「缓存到本地」：返回本地缓存文件路径
#[tauri::command]
pub async fn smb_cache_file(app: AppHandle, path: String) -> Result<String, String> {
    smb::cache_file(&path, &smb_cache_dir(&app)?)
        .await
        .map(|p| p.to_string_lossy().to_string())
}

/// 查询单个文件的缓存状态
#[tauri::command]
pub async fn smb_cached_status(
    app: AppHandle,
    path: String,
) -> Result<smb::SmbCacheStatus, String> {
    smb::cached_status(&path, &smb_cache_dir(&app)?).await
}

/// 清空全部 SMB 本地缓存，返回释放字节数
#[tauri::command]
pub async fn smb_clear_cache(app: AppHandle) -> Result<u64, String> {
    smb::clear_cache(&smb_cache_dir(&app)?)
}
