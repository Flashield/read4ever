use std::path::{Path, PathBuf};

/// 提取文件名中的数字序号和前缀、后缀，用于智能排序。
/// 例如 "A1.txt" → (prefix="A", num=1, suffix=".txt")
/// "Chapter03.txt" → (prefix="Chapter", num=3, suffix=".txt")
#[allow(dead_code)]
struct FileNum {
    prefix: String,
    num: Option<u64>,
    suffix: String,
    name: String,
}

fn parse_file_num(name: &str) -> FileNum {
    // 找到第一段连续数字
    let mut prefix_end = name.len();
    let mut num_start = None;
    let mut num_end = name.len();
    for (i, ch) in name.char_indices() {
        if ch.is_ascii_digit() {
            if num_start.is_none() {
                prefix_end = i;
                num_start = Some(i);
            }
            num_end = i + ch.len_utf8();
        } else if num_start.is_some() {
            // 数字段结束
            break;
        }
    }
    match num_start {
        Some(ns) => {
            let prefix = &name[..prefix_end];
            let num_str = &name[ns..num_end];
            let suffix = &name[num_end..];
            let num = num_str.parse::<u64>().ok();
            FileNum {
                prefix: prefix.to_string(),
                num,
                suffix: suffix.to_string(),
                name: name.to_string(),
            }
        }
        None => FileNum {
            prefix: name.to_string(),
            num: None,
            suffix: String::new(),
            name: name.to_string(),
        },
    }
}

/// 列出目录中与当前文件同扩展名的文件，按智能序号排序
fn list_sibling_files(current: &Path) -> Vec<PathBuf> {
    let dir = match current.parent() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let ext = current
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_lowercase();

    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let e = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
                    .unwrap_or_default();
                if e == ext {
                    files.push(path);
                }
            }
        }
    }

    // 智能排序：同前缀按数字排，无数字按名称排
    files.sort_by(|a, b| {
        let na = parse_file_num(
            a.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(""),
        );
        let nb = parse_file_num(
            b.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(""),
        );
        // 先按前缀排序（不区分大小写）
        let pa = na.prefix.to_lowercase();
        let pb = nb.prefix.to_lowercase();
        let cmp = pa.cmp(&pb);
        if cmp != std::cmp::Ordering::Equal {
            return cmp;
        }
        // 再按数字排序
        match (na.num, nb.num) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => na.name.cmp(&nb.name),
        }
    });
    files
}

/// 找到当前文件的下一个文件（按序号逻辑）
/// 如果当前文件 A1.txt，同目录有 A1..A10，则下一个是 A2.txt（而非 A10.txt）
pub fn find_next_file(current_path: &str) -> Option<String> {
    let current = Path::new(current_path);
    let cur_name = current.file_name()?.to_str()?.to_string();
    let cur_num = parse_file_num(&cur_name);

    let siblings = list_sibling_files(current);
    let cur_canonical = current.canonicalize().ok()?;

    // 找到当前文件在排序列表中的位置
    let mut idx = None;
    for (i, f) in siblings.iter().enumerate() {
        if let Ok(c) = f.canonicalize() {
            if c == cur_canonical {
                idx = Some(i);
                break;
            }
        }
    }

    // 如果在列表中找到，取下一个
    if let Some(i) = idx {
        if i + 1 < siblings.len() {
            return siblings[i + 1].to_str().map(|s| s.to_string());
        }
        return None;
    }

    // 没找到（可能 zip 内文件），尝试用序号匹配同前缀下一个数字
    if let Some(n) = cur_num.num {
        for f in &siblings {
            let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let fn_num = parse_file_num(name);
            if fn_num.prefix.eq_ignore_ascii_case(&cur_num.prefix) {
                if let Some(m) = fn_num.num {
                    if m == n + 1 {
                        return f.to_str().map(|s| s.to_string());
                    }
                }
            }
        }
    }

    // 最后兜底：返回列表第一个
    siblings.first().and_then(|f| f.to_str().map(|s| s.to_string()))
}

/// 找到当前文件的上一个文件
pub fn find_prev_file(current_path: &str) -> Option<String> {
    let current = Path::new(current_path);
    let cur_canonical = current.canonicalize().ok()?;
    let siblings = list_sibling_files(current);

    for (i, f) in siblings.iter().enumerate() {
        if let Ok(c) = f.canonicalize() {
            if c == cur_canonical {
                if i > 0 {
                    return siblings[i - 1].to_str().map(|s| s.to_string());
                }
                return None;
            }
        }
    }
    None
}
