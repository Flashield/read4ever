/// 重新排版：将每行都是硬回车换行的文章去掉回车重新排列，不破坏原有段落。
///
/// 规则：
/// - 空行分隔段落，保留空行
/// - 段落内：如果一行以句末标点结尾（。！？……）或本身是完整短句，保留换行；
///   否则将该行与下一行合并
/// - 行首缩进（全角空格）去重
pub fn reorder_text(text: &str) -> String {
    let mut result = String::with_capacity(text.len() + text.len() / 8);
    let lines: Vec<&str> = text.split('\n').collect();

    let mut i = 0;
    let mut pending: Option<String> = None; // 累积中的段落行

    while i < lines.len() {
        let raw = lines[i];
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();

        if trimmed.is_empty() {
            // 空行：冲刷累积的段落行，保留空行
            if let Some(p) = pending.take() {
                result.push_str(&p);
                result.push('\n');
            }
            result.push('\n');
            i += 1;
            continue;
        }

        // 去掉行首缩进（全角空格、半角空格、制表符仅第一次出现时）
        let content = line.trim_start_matches('　').trim_start_matches('\t');

        let is_para_end = is_sentence_end(trimmed);

        match pending.as_mut() {
            None => {
                pending = Some(content.to_string());
            }
            Some(p) => {
                if is_para_end {
                    // 前一行累积 + 当前行（标点结尾），结束段落
                    p.push_str(content);
                    result.push_str(p);
                    result.push('\n');
                    pending = None;
                } else {
                    // 拼接到前一行
                    p.push_str(content);
                }
            }
        }
        i += 1;
    }

    if let Some(p) = pending {
        result.push_str(&p);
        result.push('\n');
    }

    result
}

fn is_sentence_end(s: &str) -> bool {
    let s = s.trim_end();
    if s.is_empty() {
        return true;
    }
    let last = s.chars().last().unwrap();
    matches!(
        last,
        '。' | '！' | '？' | '…' | '；' | '，' | '：' | '”' | '』' | '」' | ')' | '）'
            | '.' | '!' | '?' | ',' | ';' | ':' | '"' | ']' | '}' | '>'
    )
}

/// 检测文本是否是"每行硬回车"类型（多数行都很短）
pub fn looks_like_hard_lines(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 10 {
        return false;
    }
    let short = lines
        .iter()
        .filter(|l| l.trim().chars().count() > 0 && l.trim().chars().count() < 40)
        .count();
    // 超过 70% 的行是短行（<40字）且总行数大
    short > lines.len() * 7 / 10
}
