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

/// 智能排序比较器：同前缀按数字排，无数字按名称排（纯函数，本地与 SMB 共用）
pub(crate) fn seq_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let na = parse_file_num(a);
    let nb = parse_file_num(b);
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
}

/// 列出目录中与当前文件同扩展名的文件（natural=true 自然排序，false 序号排序）
fn list_sibling_files(current: &Path, natural: bool) -> Vec<PathBuf> {
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

    files.sort_by(|a, b| {
        let na = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let nb = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if natural {
            crate::natural::natural_cmp(na, nb)
        } else {
            seq_cmp(na, nb)
        }
    });
    files
}

/// 已排序名字表中 current 的下一个名字：
/// idx 命中 → 后继；未命中（如输入名与条目名不完全一致）→ n+1 前缀兜底 → 首文件兜底。
/// idx 由调用方计算：本地按 canonicalize 等价匹配，SMB 按名字精确匹配。
/// 兜底固定按序号语义（num+1），不随 natural 参数切换；仅在当前名字不在排序表中时触发
pub(crate) fn next_among(sorted: &[String], current: &str, idx: Option<usize>) -> Option<String> {
    if let Some(i) = idx {
        return sorted.get(i + 1).cloned();
    }
    let cur_num = parse_file_num(current);
    if let Some(n) = cur_num.num {
        for name in sorted {
            let f = parse_file_num(name);
            if f.prefix.eq_ignore_ascii_case(&cur_num.prefix) {
                if let Some(m) = f.num {
                    if m == n + 1 {
                        return Some(name.clone());
                    }
                }
            }
        }
    }
    sorted.first().cloned()
}

/// 已排序名字表中位置 idx 的上一个名字（首元素/未命中 → None）
pub(crate) fn prev_among(sorted: &[String], idx: usize) -> Option<String> {
    if idx > 0 {
        Some(sorted[idx - 1].clone())
    } else {
        None
    }
}

/// 名字 → 同目录兄弟列表中的完整路径（目录内名字唯一）
fn path_of_name(siblings: &[PathBuf], name: &str) -> Option<String> {
    siblings
        .iter()
        .find(|f| f.file_name().and_then(|n| n.to_str()) == Some(name))
        .and_then(|f| f.to_str().map(|s| s.to_string()))
}

/// 找到当前文件的下一个文件（natural=true 自然排序，false 按序号逻辑）
/// 序号逻辑：如果当前文件 A1.txt，同目录有 A1..A10，则下一个是 A2.txt（而非 A10.txt）
pub fn find_next_file(current_path: &str, natural: bool) -> Option<String> {
    let current = Path::new(current_path);
    let cur_name = current.file_name()?.to_str()?.to_string();
    let siblings = list_sibling_files(current, natural);
    let cur_canonical = current.canonicalize().ok()?;
    let names: Vec<String> = siblings
        .iter()
        .map(|f| f.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string())
        .collect();
    // canonicalize 匹配（大小写不敏感文件系统下输入名可能与实际条目大小写不同）
    let idx = siblings
        .iter()
        .position(|f| f.canonicalize().is_ok_and(|c| c == cur_canonical));
    let name = next_among(&names, &cur_name, idx)?;
    path_of_name(&siblings, &name)
}

/// 找到当前文件的上一个文件（natural=true 自然排序，false 按序号逻辑）
pub fn find_prev_file(current_path: &str, natural: bool) -> Option<String> {
    let current = Path::new(current_path);
    let cur_canonical = current.canonicalize().ok()?;
    let siblings = list_sibling_files(current, natural);

    for (i, f) in siblings.iter().enumerate() {
        if let Ok(c) = f.canonicalize() {
            if c == cur_canonical {
                let names: Vec<String> = siblings
                    .iter()
                    .map(|f| f.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string())
                    .collect();
                let name = prev_among(&names, i)?;
                return path_of_name(&siblings, &name);
            }
        }
    }
    None
}
