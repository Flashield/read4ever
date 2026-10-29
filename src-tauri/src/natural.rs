//! 文件名自然排序比较器（docs/自然排序与SMB远程写操作方案.md 需求 1）。
//! 与前端 src/natural.ts 的 naturalCompare 语义对齐：
//! 数字段按数值比（数值相等时段短者在前；超 u64 的段溢出兜底，仅保证全序不保证
//! 精确值序），非数字段按小写码点比，数字段先于非数字段；逐段等价按原串字节序兜底。

/// 切出首段：Some((段, 是否数字段))；s 为空返回 None
fn next_segment(s: &str) -> Option<(&str, bool)> {
    let first = s.chars().next()?;
    let digit = first.is_ascii_digit();
    let end = s
        .find(|c: char| c.is_ascii_digit() != digit)
        .unwrap_or(s.len());
    Some((&s[..end], digit))
}

pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut sa, mut sb) = (a, b);
    loop {
        match (next_segment(sa), next_segment(sb)) {
            (None, None) => return a.cmp(b), // 逐段等价时按原串字节序兜底，排序结果与枚举顺序无关
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some((xa, da)), Some((xb, db))) => {
                let ord = match (da, db) {
                    (true, true) => {
                        // 超长数字段溢出按 u64::MAX 兜底，再比段长
                        let na = xa.parse::<u64>().unwrap_or(u64::MAX);
                        let nb = xb.parse::<u64>().unwrap_or(u64::MAX);
                        na.cmp(&nb).then(xa.len().cmp(&xb.len()))
                    }
                    (true, false) => Ordering::Less, // 数字段先于非数字段
                    (false, true) => Ordering::Greater,
                    (false, false) => xa.to_lowercase().cmp(&xb.to_lowercase()),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
                sa = &sa[xa.len()..];
                sb = &sb[xb.len()..];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering::*;

    fn assert_sorted(names: &[&str]) {
        for w in names.windows(2) {
            assert_eq!(natural_cmp(w[0], w[1]), Less, "「{}」应排在「{}」前", w[0], w[1]);
            assert_eq!(natural_cmp(w[1], w[0]), Greater, "「{}」应排在「{}」后", w[1], w[0]);
        }
    }

    #[test]
    fn 数值序() {
        assert_sorted(&["file2.txt", "file10.txt"]);
        assert_sorted(&["第2节.txt", "第10节.txt"]);
        assert_sorted(&["a2b.txt", "a10b.txt"]);
        assert_sorted(&["第01话 第2节.txt", "第01话 第10节.txt"]);
    }

    #[test]
    fn 前导零_数值相等时段短者在前() {
        assert_sorted(&["file2.txt", "file02.txt"]);
    }

    #[test]
    fn 数字段先于非数字段与纯数字名() {
        assert_sorted(&["1a", "a1"]);
        assert_sorted(&["2", "10"]);
    }

    #[test]
    fn 大小写不敏感与多段() {
        assert_sorted(&["A1.txt", "a2.txt"]);
        assert_sorted(&["a1.txt", "a1b.txt"]);
    }

    #[test]
    fn 超长数字段溢出兜底() {
        // 数值溢出同 u64::MAX 时按逐段等价字节序兜底：a.cmp(b) 作最终 tie-break，排序结果与枚举顺序无关
        assert_eq!(
            natural_cmp("18446744073709551615", "18446744073709551616"),
            Less // 两侧同为 20 位、同溢出兜底 u64::MAX，段长平手后按字节序兜底 '5'<'6'
        );
        // 双溢出时段短者在前：20 位 < 21 位（溢出兜底仍比段长）
        assert_sorted(&["99999999999999999999", "100000000000000000000"]);
    }

    #[test]
    fn 空串与相等() {
        assert_eq!(natural_cmp("", ""), Equal);
        assert_eq!(natural_cmp("same.txt", "same.txt"), Equal);
        assert_sorted(&["", "a.txt"]);
    }
}
