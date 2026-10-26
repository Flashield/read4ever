mod commands;
pub mod encoding; // pub：src-tauri/tests 集成测试访问
mod plugin_pkg;
mod reorder;
mod seqfile;
mod store;
pub mod zipfile; // pub：src-tauri/tests 集成测试访问

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 系统托盘
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("ReadBook - 文本阅读器")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
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
        ])
        .on_window_event(|window, event| {
            // 关闭窗口时隐藏到托盘而非退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
