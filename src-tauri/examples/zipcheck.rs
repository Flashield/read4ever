/// zip 解析对比诊断：cargo run --example zipcheck -- "路径"
fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("用法: cargo run --example zipcheck -- <zip路径>");
            std::process::exit(1);
        }
    };
    println!("路径: {path}");

    // 1) File + ZipArchive::new
    match std::fs::File::open(&path) {
        Ok(f) => match zip::ZipArchive::new(f) {
            Ok(a) => println!("[File+ZipArchive] OK, {} 个条目", a.len()),
            Err(e) => println!("[File+ZipArchive] 失败: {e}"),
        },
        Err(e) => println!("打开失败: {e}"),
    }

    // 2) Cursor(全量内存) + ZipArchive::new
    let data = std::fs::read(&path).expect("读文件失败");
    match zip::ZipArchive::new(std::io::Cursor::new(&data[..])) {
        Ok(a) => println!("[Cursor+ZipArchive] OK, {} 个条目", a.len()),
        Err(e) => println!("[Cursor+ZipArchive] 失败: {e}"),
    }

    // 3) 手工从后往前扫 PK\x05\x06
    let mut found = 0;
    for i in (0..data.len().saturating_sub(4)).rev() {
        if &data[i..i + 4] == b"PK\x05\x06" {
            println!("[手工扫描] PK\\x05\\x06 @ {i}");
            found += 1;
            if found >= 3 {
                break;
            }
        }
    }
    if found == 0 {
        println!("[手工扫描] 内存中没有找到 EOCD 魔数!");
    }

    // 4) 扫 PK\x01\x02（中央目录头）
    let mut found2 = 0;
    for i in (0..data.len().saturating_sub(4)).rev() {
        if &data[i..i + 4] == b"PK\x01\x02" {
            println!("[手工扫描] PK\\x01\\x02 @ {i}");
            found2 += 1;
            if found2 >= 3 {
                break;
            }
        }
    }
}
