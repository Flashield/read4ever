use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use crate::encoding::encode_text;
use crate::reorder::{looks_like_hard_lines, reorder_text};
use crate::seqfile::{find_next_file, find_prev_file};
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
}

/// 打开文本文件（通过前端 dialog 拿到路径后调用）。
/// encoding 不为 None 时按指定编码解码（手动重新打开场景）。
#[tauri::command]
pub fn open_text_file(path: String, encoding: Option<String>) -> Result<FileContent, String> {
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
    })
}

/// 打开 zip，返回内部全部文件条目（类型过滤由前端按插件能力决定）
#[tauri::command]
pub fn open_zip_file(path: String) -> Result<Vec<String>, String> {
    crate::zipfile::list_zip_files(&path)
}

/// 读取磁盘文件原始字节（二进制插件用；前端 invoke 得到 ArrayBuffer）
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Response, String> {
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

/// 列出单层目录：目录优先、按名称排序，跳过隐藏文件
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
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
