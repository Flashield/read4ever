/* 编码检测的集成测试（自 src/encoding.rs 内联测试模块迁出）。 */
use read4ever_lib::encoding::decode_with;
use read4ever_lib::zipfile::{list_zip_txt, read_zip_entry};

/// GBK 无 BOM 的中文小说样本：chardetng 会误判为 windows-1252，
/// 所有非 GB18030 编码都无法完整解码。
/// （原为硬编码 Windows 绝对路径，本机不存在恒跳过；改为工作区相对路径后可真正运行）
const SAMPLE_ZIP: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../佛系少女升职记_佛系少女升职记.zip"
);

#[tokio::test]
async fn detects_gbk_novel_in_zip() {
    if !std::path::Path::new(SAMPLE_ZIP).exists() {
        return; // 样本不在时跳过
    }
    let entries = list_zip_txt(SAMPLE_ZIP).await.expect("应能列出条目");
    let (text, label) = read_zip_entry(SAMPLE_ZIP, &entries[0], None)
        .await
        .expect("应能读取");
    println!("检测编码: {}, 开头: {}", label, text.chars().take(30).collect::<String>());
    assert_eq!(label, "GB18030", "GBK 小说应判为 GB18030");
    assert!(text.contains("佛系少女升职记"), "解码内容应当正确");
}

#[test]
fn forced_encoding_decodes_directly() {
    let gbk_bytes = [0xa1, 0xb6, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xb7]; // 《测试》
    let (text, label) = decode_with(&gbk_bytes, "GB18030").unwrap();
    assert_eq!(label, "GB18030");
    assert_eq!(text, "《测试》");
    assert!(decode_with(&gbk_bytes, "not-an-encoding").is_err());
}
