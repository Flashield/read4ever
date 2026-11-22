mod commands;
pub mod encoding; // pub：src-tauri/tests 集成测试访问
mod natural;
mod plugin_pkg;
mod reorder;
mod seqfile;
mod smb;
mod stream;
mod store;
mod wake;
pub mod zipfile; // pub：src-tauri/tests 集成测试访问

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ctx = tauri::generate_context!();
    // 默认单实例：store 设置允许多开时不注册插件（变更重启后生效；缺失/损坏一律单实例兜底）
    let allow_multiple = store::read_allow_multiple(&ctx.config().identifier);
    let mut builder = tauri::Builder::default();
    // single-instance 插件要求最先注册（互斥资源在 init 时建立）；
    // 门控先例同 keepawake/trash：插件无 iOS 后端，仅桌面三平台引入。
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        if !allow_multiple {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                // 重复启动 → 唤起并聚焦已有窗口（含托盘隐藏态）
                commands::show_main_from_tray(app);
            }));
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let _ = allow_multiple;
    let builder = builder.plugin(tauri_plugin_dialog::init());
    let builder = stream::register(builder).manage(wake::WakeState::default());
    builder
        .setup(|app| {
            // 系统托盘
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Read4Ever - 文本阅读器")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => commands::show_main_from_tray(app),
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_text_file,
            commands::open_zip_file,
            commands::read_zip_entry,
            commands::save_text_file,
            commands::edit_save,
            commands::reorder,
            commands::find_next,
            commands::find_prev,
            commands::load_store,
            commands::save_store,
            commands::set_window_title,
            commands::hide_to_tray,
            commands::show_from_tray,
            commands::exit_app,
            commands::list_dir,
            commands::trash_path,
            commands::move_path,
            commands::rename_path,
            commands::make_dir,
            commands::read_file_bytes,
            commands::read_zip_entry_bytes,
            commands::list_plugins,
            commands::install_plugin,
            commands::uninstall_plugin,
            commands::read_plugin_file,
            commands::smb_put_servers,
            commands::smb_test_connection,
            commands::smb_list_dir,
            commands::smb_cache_file,
            commands::smb_cached_status,
            commands::smb_clear_cache,
            commands::smb_delete,
            commands::smb_rename,
            commands::smb_move,
            commands::smb_mkdir,
            wake::set_keep_awake,
        ])
        .on_window_event(|window, event| {
            // 关闭窗口时隐藏到托盘而非退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                commands::hide_main_to_tray(window.app_handle());
                api.prevent_close();
            }
        })
        .run(ctx)
        .expect("error while running tauri application");
}
