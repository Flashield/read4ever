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
/// 命令保持同步（主线程执行）：Windows 的 SetThreadExecutionState 建立与释放
/// 必须同线程，改成 async 会在 Windows 上泄漏显示抑制。
#[tauri::command]
pub fn set_keep_awake(on: bool, state: tauri::State<WakeState>) {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        let mut g = state.guard.lock().unwrap();
        if on {
            if g.is_none() {
                match keepawake::Builder::default()
                    .display(true) // 阻止屏保/显示休眠
                    .idle(true) // 阻止空闲待机（需求含「待机」；不拦用户主动睡眠），并使 Linux 建立 logind fd 锁
                    .app_name("Read4Ever") // logind 抑制项的应用名（systemd-inhibit --list 可见）
                    .app_reverse_domain("io.github.read4ever") // org.freedesktop.ScreenSaver 抑制在 DE 界面显示的应用名
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
