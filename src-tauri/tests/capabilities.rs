/* capabilities 权限清单回归测试：前端经 __TAURI__ 调用的窗口 API 需在
   capabilities/default.json 显式授权，缺失时 invoke 被静默拒绝（错误只在
   Promise rejection 里，UI 侧多半被 catch 吞掉）——本仓库已三次踩坑：
   置顶缺 allow-set-always-on-top、中央拖动缺 allow-start-dragging、
   无边框自管拖窗缺 allow-set-position。此处固定「前端实际用到的写操作」
   清单，删除权限时测试即红。 */

use std::fs;
use std::path::Path;

/// 前端代码实际调用的窗口写操作权限（与 src/ 各模块 getCurrentWindow() 用法对应）
const REQUIRED: &[&str] = &[
    "core:window:allow-set-fullscreen",    // fullscreen.ts 沉浸模式
    "core:window:allow-set-decorations",   // fullscreen.ts 无边框模式
    "core:window:allow-set-always-on-top", // fullscreen.ts 窗口置顶
    "core:window:allow-set-position",      // fullscreen.ts 无边框自管拖窗
    "core:window:allow-start-dragging",    // 预留（tao start_dragging）
];

#[test]
fn capabilities_cover_all_window_writes_used_by_frontend() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
    let raw = fs::read_to_string(&path).expect("capabilities/default.json 应存在");
    for perm in REQUIRED {
        assert!(
            raw.contains(&format!("\"{perm}\"")),
            "capabilities/default.json 缺少权限 {perm}：前端相关窗口操作会被静默拒绝\n{raw}"
        );
    }
}
