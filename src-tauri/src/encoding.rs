use encoding_rs::{Encoding, UTF_16BE, UTF_16LE};

/// 检测字节流的文本编码并解码为 String。
/// 识别顺序：UTF-8/UTF-16 BOM → 纯 UTF-8 → chardetng 检测 → 中文候选重新评分。
pub fn detect_and_decode(data: &[u8]) -> (String, &'static str) {
    // 1. BOM 检测
    if data.len() >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
        return (String::from_utf8_lossy(&data[3..]).into_owned(), "UTF-8");
    }
    if data.len() >= 2 && data[0] == 0xFF && data[1] == 0xFE {
        // UTF-16 LE
        let (s, _, _) = UTF_16LE.decode(&data[2..]);
        return (s.into_owned(), "UTF-16LE");
    }
    if data.len() >= 2 && data[0] == 0xFE && data[1] == 0xFF {
        // UTF-16 BE
        let (s, _, _) = UTF_16BE.decode(&data[2..]);
        return (s.into_owned(), "UTF-16BE");
    }

    // 2. 尝试纯 UTF-8（很多 txt 就是 UTF-8 无 BOM）
    if let Ok(s) = std::str::from_utf8(data) {
        return (s.to_string(), "UTF-8");
    }

    // 3. chardetng 检测。只喂头部采样：其状态机按字节线性扫描，
    //    全量喂大文件极慢（实测 670KB 约 2.5s）；采样前 16KB 猜测结果
    //    与全量一致（实测 GB18030/Big5 均如此），且足够稳定。
    let sample = &data[..data.len().min(16 * 1024)];
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, true);
    let enc = detector.guess(None, true);

    // 4. chardetng 会把部分 GBK 中文判成单字节西文（如 windows-1252），
    //    按它解码整篇乱码。数据明显是多字节时，改在中文候选里重新判断；
    //    只有西里尔文本等确凿的单字节场景维持原判。
    if enc.is_single_byte() {
        if high_byte_ratio(data) < 0.15 || is_cyrillic(enc) {
            let (s, _, _) = enc.decode(data);
            return (s.into_owned(), enc.name());
        }
        return detect_chinese(data);
    }
    let (s, _, _) = enc.decode(data);
    // 新版 encoding_rs 中 GBK 是独立编码（name 为 "GBK"），归一为 GB18030，
    // 与 detect_chinese / decode_with 的 label 风格统一
    let label = if enc.name() == "GBK" { "GB18030" } else { enc.name() };
    (s.into_owned(), label)
}

/// 按指定编码直接解码（用于手动"以编码重新打开"）
pub fn decode_with(data: &[u8], encoding: &str) -> Result<(String, String), String> {
    let enc = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("未知编码: {}", encoding))?;
    let (s, _, _) = enc.decode(data);
    // 统一 label 风格（encoding_rs 返回小写名）
    let label = match enc.name() {
        "gb18030" => "GB18030",
        "big5" => "Big5",
        "utf-8" => "UTF-8",
        "utf-16le" => "UTF-16LE",
        "utf-16be" => "UTF-16BE",
        other => other,
    };
    Ok((s.into_owned(), label.to_string()))
}

fn high_byte_ratio(data: &[u8]) -> f32 {
    if data.is_empty() {
        return 0.0;
    }
    let n = data.iter().filter(|&&b| b >= 0x80).count();
    n as f32 / data.len() as f32
}

fn is_cyrillic(enc: &'static Encoding) -> bool {
    matches!(
        enc.name(),
        "windows-1251" | "KOI8-R" | "ISO-8859-5" | "IBM866" | "x-mac-cyrillic"
    )
}

/// 简体/繁体特征字（仅存在于一种字形体系的常用字，用于区分 GB18030 与 Big5）
const SIMPLIFIED_ONLY: &str = "这来时说国会开关门东车马鸟书长见对经过还发现问题请谢没们为学体头万机电进远运读发变输实测认结让讯该记设谈证调员贵资购费贝页预订车轻输较辅辆软";
const TRADITIONAL_ONLY: &str = "這來時說國會開關門東車馬鳥書長見對經過還發現問題請謝沒們為學體頭萬機電進遠運讀發變輸實測認結讓訊該記設談證調員貴資購費貝頁預訂車輕輸較輔輛軟";

fn common_char_ratio(text: &str, set: &str) -> f32 {
    let total = text.chars().count().max(1) as f32;
    let hits = text.chars().filter(|c| set.contains(*c)).count() as f32;
    hits / total
}

/// 在中文常见编码（无 BOM UTF-16 / GB18030 / Big5）中挑选最合适的。
/// GB18030 能无错解码任何字节序列，因此 Big5 必须先证明自己：
/// 能无错解码且繁体特征字明显占优时才选 Big5，否则 GB18030。
fn detect_chinese(data: &[u8]) -> (String, &'static str) {
    // 无 BOM 的 UTF-16：0x00 字节很多
    let zeros = data.iter().filter(|&&b| b == 0).count();
    if zeros * 10 > data.len() {
        let (le, _, _) = UTF_16LE.decode(data);
        let (be, _, _) = UTF_16BE.decode(data);
        let (s, label) = if cjk_ratio(&le) >= cjk_ratio(&be) {
            (&le, "UTF-16LE")
        } else {
            (&be, "UTF-16BE")
        };
        if cjk_ratio(s) > 0.2 {
            return (s.clone().into_owned(), label);
        }
    }

    let (gb, _, _) = encoding_rs::GB18030.decode(data);
    let (_, _, big5_had_errors) = encoding_rs::BIG5.decode(data);
    if !big5_had_errors {
        let (big5, _, _) = encoding_rs::BIG5.decode(data);
        if common_char_ratio(&big5, TRADITIONAL_ONLY) > common_char_ratio(&gb, SIMPLIFIED_ONLY) * 1.3 {
            return (big5.into_owned(), "Big5");
        }
    }
    (gb.into_owned(), "GB18030")
}

/// 统计 CJK（汉字/中文标点/全角字符）占比
fn cjk_ratio(text: &str) -> f32 {
    let mut total = 0usize;
    let mut cjk = 0usize;
    for c in text.chars() {
        total += 1;
        let cp = c as u32;
        if matches!(cp, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3000..=0x303F | 0xFF00..=0xFFEF) {
            cjk += 1;
        }
    }
    cjk as f32 / total.max(1) as f32
}

/// 将字符串按指定编码编码回字节（用于"另存为"保持编码一致）
pub fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    let enc = match encoding.to_uppercase().as_str() {
        "UTF-16LE" => encoding_rs::UTF_16LE,
        "UTF-16BE" => encoding_rs::UTF_16BE,
        "BIG5" => encoding_rs::BIG5,
        "GB18030" | "GBK" | "GB2312" => encoding_rs::GB18030,
        _ => encoding_rs::UTF_8,
    };
    let (bytes, _, _) = enc.encode(text);
    bytes.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn build_chinese_text(target_bytes: usize) -> String {
        let sentences = [
            "他说这句话的时候，眼神里透着一种说不出的疲惫，仿佛这十年的风霜都写在了脸上。",
            "窗外下着淅淅沥沥的小雨，街灯把湿漉漉的路面照得一片昏黄，行人撑着伞匆匆走过。",
            "这件事说来话长，得从二十年前那个夏天讲起，那时候他们都还年轻，什么都不怕。",
            "国会议员经过长时间讨论，终于对这项法案达成了一致，门外的记者蜂拥而入。",
        ];
        let mut text = String::new();
        let mut i = 0;
        while text.len() < target_bytes {
            text.push_str(sentences[i % sentences.len()]);
            text.push('\n');
            i += 1;
        }
        text
    }

    /// 回归：大输入（约 670KB GB18030）编码检测须在 500ms 内完成。
    /// 修复前把全量字节喂给 chardetng 状态机，约 2.5s/670KB。
    #[test]
    fn large_input_detection_is_fast() {
        let text = build_chinese_text(1_000_000);
        let (gb, _, _) = encoding_rs::GB18030.encode(&text);
        let t = Instant::now();
        let (decoded, label) = detect_and_decode(&gb);
        let elapsed = t.elapsed();
        assert_eq!(decoded, text);
        println!("detect_and_decode {}B 耗时: {:?}", gb.len(), elapsed);
        assert!(
            label.eq_ignore_ascii_case("gb18030") || label.eq_ignore_ascii_case("gbk"),
            "中文应识别为 GB18030/GBK，实际: {}",
            label
        );
        assert!(elapsed < Duration::from_millis(500), "编码检测耗时 {:?}，超过 500ms", elapsed);
    }
}
