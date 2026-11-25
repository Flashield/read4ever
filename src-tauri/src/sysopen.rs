/* 系统打开请求：由操作系统而非应用界面发起的打开（词汇表「系统打开请求」）。
   来源有三：启动参数（未运行时）、单实例插件转发的第二实例参数（已在运行时，Windows/Linux）、
   macOS/iOS 的「打开文件」事件（Finder「打开方式」）。

   前端就绪前到达的请求先排队，由前端在启动恢复完成后取走（take_pending_opens）；
   就绪后到达的直接经 rb-open-paths 事件推送。只用 std 与 tauri 跨平台接口，桌面与 iOS 共用。 */

use std::ffi::OsStr;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Url};

/// 请求直送前端时的事件名
pub const EVENT: &str = "rb-open-paths";

/// submit 的去向
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// 前端未就绪：已排队
    Queued,
    /// 前端已就绪：应直接推送给它
    Emit(Vec<String>),
    /// 空请求
    Ignored,
}

#[derive(Default)]
struct Inner {
    /// 前端尚未就绪：请求在此排队
    pending: Vec<String>,
    /// 前端已取过一次（启动恢复完成）
    ready: bool,
}

impl Inner {
    fn submit(&mut self, paths: Vec<String>) -> Delivery {
        if paths.is_empty() {
            return Delivery::Ignored;
        }
        if self.ready {
            return Delivery::Emit(paths);
        }
        self.pending.extend(paths);
        Delivery::Queued
    }
}

/// 系统打开请求的排队状态（app 管理的状态）
#[derive(Default)]
pub struct SysOpen {
    inner: Mutex<Inner>,
}

impl SysOpen {
    /// 预置已排队的请求（启动参数）
    pub fn with_pending(pending: Vec<String>) -> Self {
        Self {
            inner: Mutex::new(Inner { pending, ready: false }),
        }
    }

    fn admit(&self, paths: Vec<String>) -> Delivery {
        self.inner.lock().unwrap().submit(paths)
    }

    /// 前端启动恢复完成后调用：取走排队请求，此后的请求直送
    pub fn take(&self) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        inner.ready = true;
        std::mem::take(&mut inner.pending)
    }
}

/// 从命令行参数里挑出存在的路径（文件，或目录——目录交给前端按「无法打开的项」提示）。
/// 不存在的参数（开关、系统附带的 -psn_ 之类）一律忽略
pub fn paths_from_args<S: AsRef<OsStr>>(args: impl IntoIterator<Item = S>) -> Vec<String> {
    args.into_iter()
        .filter_map(|a| {
            let p = Path::new(a.as_ref());
            (p.is_file() || p.is_dir()).then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

/// 「打开文件」事件只取本地文件 URL
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub fn paths_from_urls(urls: &[Url]) -> Vec<String> {
    urls.iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// 系统打开请求入口：前端未就绪时排队，就绪后直接推送给它
pub fn submit(app: &AppHandle, paths: Vec<String>) {
    let delivery = app.try_state::<SysOpen>().map(|s| s.admit(paths));
    if let Some(Delivery::Emit(paths)) = delivery {
        let _ = app.emit(EVENT, paths);
    }
}

/// 第二实例转发的命令行参数（首个是可执行文件自身）
pub fn submit_args(app: &AppHandle, argv: &[String]) {
    submit(app, paths_from_args(argv.iter().skip(1)));
}

/// 「打开文件」事件里的文件
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub fn submit_urls(app: &AppHandle, urls: &[Url]) {
    submit(app, paths_from_urls(urls));
}

/// 事件循环回调。macOS 点 Dock 图标而没有可见窗口（藏在托盘）时显示主窗口
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        // 藏在托盘时从 Finder「打开方式」打开文件：先把窗口唤回再打开
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        tauri::RunEvent::Opened { urls } => {
            #[cfg(target_os = "macos")]
            crate::commands::show_main_from_tray(app);
            submit_urls(app, &urls);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { has_visible_windows } => {
            if !has_visible_windows {
                crate::commands::show_main_from_tray(app);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn requests_queue_until_frontend_takes_over_then_go_straight_out() {
        let s = SysOpen::default();
        assert_eq!(s.admit(vec!["/a.txt".into()]), Delivery::Queued);
        assert_eq!(s.admit(vec!["/b.txt".into()]), Delivery::Queued);
        assert_eq!(s.take(), vec!["/a.txt".to_string(), "/b.txt".to_string()]);
        assert_eq!(s.admit(vec!["/c.txt".into()]), Delivery::Emit(vec!["/c.txt".into()]));
        assert!(s.take().is_empty(), "就绪后不再排队");
    }

    #[test]
    fn empty_request_is_ignored() {
        let s = SysOpen::default();
        assert_eq!(s.admit(Vec::new()), Delivery::Ignored);
        assert!(s.take().is_empty());
    }

    #[test]
    fn args_keep_only_existing_paths_in_order() {
        let exe = std::env::current_exe().unwrap();
        let dir = std::env::temp_dir();
        let missing = dir.join("read4ever-no-such-file.txt");
        let got = paths_from_args([
            OsString::from("--flag"),
            exe.as_os_str().to_os_string(),
            missing.into_os_string(),
            dir.as_os_str().to_os_string(),
        ]);
        assert_eq!(
            got,
            vec![exe.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn only_file_urls_become_paths() {
        let local = Url::from_file_path(std::env::temp_dir().join("x y.txt")).unwrap();
        let got = paths_from_urls(&[Url::parse("https://example.com/a.txt").unwrap(), local]);
        assert_eq!(got, vec![std::env::temp_dir().join("x y.txt").to_string_lossy().into_owned()]);
    }
}
