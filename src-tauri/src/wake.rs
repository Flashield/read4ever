/* 屏幕常亮：前端按来源聚合成单一开关（docs/屏幕常亮方案.md），此处只持有/释放 RAII guard。
   桌面三平台用 keepawake crate（Linux: org.freedesktop.ScreenSaver + logind Inhibit(fd 锁)；
   macOS: IOPMAssertionCreateWithName；Windows: SetThreadExecutionState），Drop 即释放，
   进程退出/崩溃也随 fd 丢弃自动解除，无需清理代码。
   其余目标（iOS）暂为 no-op：落地时加 objc2-ui-kit 分支，经 app_handle.run_on_main_thread
   设 UIApplication.idleTimerDisabled——命令签名与前端零改动。 */
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use std::sync::Mutex;

/// cfg 必须与 Cargo.toml 的依赖门控严格一致（不用 cfg(desktop)，防其他桌面目标误入）
#[derive(Default)]
pub struct WakeState {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    guard: Mutex<Option<keepawake::KeepAwake>>,
}

/// 屏幕常亮总开关（幂等）。抑制失败（如无 D-Bus 的环境）只打日志不报错——
/// 屏保抑制是尽力而为的体验增强，不能阻断阅读。
#[tauri::command]
pub fn set_keep_awake(on: bool, state: tauri::State<WakeState>) {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        let mut g = state.guard.lock().unwrap();
        if on {
            if g.is_none() {
                match keepawake::Builder::default()
                    .display(true) // 只阻止屏保/显示休眠，不抑制系统主动睡眠语义
                    .app_name("ReadBook")
                    .reason("滚屏/播放中")
                    .create()
                {
                    Ok(k) => *g = Some(k),
                    Err(e) => eprintln!("[wake] 保持常亮失败（忽略）：{e}"),
                }
            }
        } else {
            *g = None; // Drop 释放
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let _ = (on, state);
}
