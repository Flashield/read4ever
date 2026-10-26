/* zipfile 宽容解析的集成测试（自 src/zipfile.rs 内联测试模块迁出）。
   样本位于工作区根目录（readbook 的上一级），不存在时跳过。 */
use readbook_lib::zipfile::{list_zip_files, list_zip_txt, read_zip_entry, read_zip_entry_raw};
use std::fs::File;
use std::path::Path;
use zip::ZipArchive;

/// 已知损坏样本：Unicode Path 扩展字段 CRC 错误，zip crate 会拒绝。
/// 样本在工作区根目录（readbook 的上一级）。
const BROKEN_ZIP: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../丰子恺散文_丰子恺散文.zip"
);

#[test]
fn opens_zip_with_bad_unicode_path_crc() {
    if !Path::new(BROKEN_ZIP).exists() {
        return; // 样本不在时跳过
    }
    // zip crate 直接失败（确认兼容场景仍存在）
    assert!(ZipArchive::new(File::open(BROKEN_ZIP).unwrap()).is_err());

    let entries = list_zip_txt(BROKEN_ZIP).expect("宽容解析应当成功");
    assert_eq!(entries, vec!["丰子恺散文/丰子恺散文.txt"]);

    let (text, _) = read_zip_entry(BROKEN_ZIP, "丰子恺散文/丰子恺散文.txt", None).expect("应当能读取");
    assert!(text.contains("丰子恺"), "解压出的内容应当是丰子恺散文");
}

#[test]
fn cached_reads_repeat_and_list_matches() {
    if !Path::new(BROKEN_ZIP).exists() {
        return;
    }
    // 走缓存路径连续读取同一资源，结果必须一致且列表稳定
    let a = read_zip_entry_raw(BROKEN_ZIP, "丰子恺散文/丰子恺散文.txt").expect("第一次读取");
    let b = read_zip_entry_raw(BROKEN_ZIP, "丰子恺散文/丰子恺散文.txt").expect("第二次读取（缓存）");
    assert_eq!(a, b);
    let all = list_zip_files(BROKEN_ZIP).expect("列出条目");
    assert!(all.iter().any(|n| n.ends_with(".txt")));
}

/// 网络驱动器大 zip 诊断：存在时打印代码路径与逐图读取耗时（cargo test -- --nocapture）
#[test]
fn perf_network_zip_diag() {
    const P: &str = "/Volumes/Seagate12T/Picture/NudeClean/00Test.zip";
    if !Path::new(P).exists() {
        return;
    }
    let t0 = std::time::Instant::now();
    let names = list_zip_files(P).expect("列出条目");
    println!("缓存构建+列出条目({}): {:?}", names.len(), t0.elapsed());
    let imgs: Vec<String> = names
        .iter()
        .filter(|n| {
            let l = n.to_ascii_lowercase();
            l.ends_with(".jpg") || l.ends_with(".jpeg") || l.ends_with(".png") || l.ends_with(".webp")
        })
        .cloned()
        .collect();
    println!("图片 {} 张（宽容解析，条目 seek 读取）", imgs.len());
    for name in imgs.iter().take(5) {
        let t = std::time::Instant::now();
        let buf = read_zip_entry_raw(P, name).expect("读条目");
        println!("读取 {} {:.0}KB → {:?}", name, buf.len() as f64 / 1024.0, t.elapsed());
    }
}
