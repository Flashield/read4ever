/* Tauri 后端命令封装 */
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  FileContent,
  FileEntry,
  PluginPkgInfo,
  SmbCacheStatus,
  SmbFileEntry,
  SmbServer,
  StoreData,
} from "./types";

export const api = {
  openText: (path: string, encoding?: string) =>
    invoke<FileContent>("open_text_file", { path, encoding: encoding ?? null }),
  listZip: (path: string, natural: boolean) =>
    invoke<string[]>("open_zip_file", { path, natural }),
  readZip: (path: string, entryName: string, encoding?: string) =>
    invoke<FileContent>("read_zip_entry", { path, entryName, encoding: encoding ?? null }),
  saveText: (path: string, content: string, encoding: string) =>
    invoke<void>("save_text_file", { path, content, encoding }),
  editSave: (path: string, content: string, encoding: string) =>
    invoke<void>("edit_save", { path, content, encoding }),
  reorder: (content: string) => invoke<string>("reorder", { content }),
  nextFile: (path: string, natural: boolean) =>
    invoke<string | null>("find_next", { path, natural }),
  prevFile: (path: string, natural: boolean) =>
    invoke<string | null>("find_prev", { path, natural }),
  loadStore: () => invoke<StoreData>("load_store"),
  saveStore: (data: StoreData) => invoke<void>("save_store", { data }),
  setTitle: (title: string) => invoke<void>("set_window_title", { title }),
  hideToTray: () => invoke<void>("hide_to_tray"),
  exitApp: () => invoke<void>("exit_app"),
  setKeepAwake: (on: boolean) => invoke<void>("set_keep_awake", { on }),

  /* 文件夹侧栏 */
  listDir: (path: string, natural: boolean) =>
    invoke<FileEntry[]>("list_dir", { path, natural }),
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  moveTo: (from: string, toDir: string) => invoke<string>("move_path", { from, toDir }),
  renamePath: (from: string, newName: string) =>
    invoke<string>("rename_path", { from, newName }),
  makeDir: (parent: string, name: string) => invoke<string>("make_dir", { parent, name }),

  /* 二进制读取（插件用；命令返回 tauri ipc Response → ArrayBuffer） */
  readFileBytes: (path: string) => invoke<ArrayBuffer>("read_file_bytes", { path }),
  readZipBytes: (path: string, entryName: string) =>
    invoke<ArrayBuffer>("read_zip_entry_bytes", { path, entryName }),

  /* 外部插件包（.rbplugin） */
  listPlugins: () => invoke<PluginPkgInfo[]>("list_plugins"),
  installPlugin: (zipPath: string) => invoke<PluginPkgInfo>("install_plugin", { zipPath }),
  uninstallPlugin: (id: string) => invoke<void>("uninstall_plugin", { id }),
  readPluginFile: (id: string, name: string) =>
    invoke<ArrayBuffer>("read_plugin_file", { id, name }),

  /* SMB 远程 */
  smbPutServers: (servers: SmbServer[]) =>
    invoke<void>("smb_put_servers", { servers }),
  smbTest: (server: SmbServer) => invoke<string>("smb_test_connection", { server }),
  smbListDir: (path: string, natural: boolean) =>
    invoke<SmbFileEntry[]>("smb_list_dir", { path, natural }),
  smbCacheFile: (path: string) => invoke<string>("smb_cache_file", { path }),
  smbCachedStatus: (path: string) => invoke<SmbCacheStatus>("smb_cached_status", { path }),
  smbClearCache: () => invoke<number>("smb_clear_cache"),

  /* 文件对话框 */
  pickOpenFile: async (extraExts: string[] = []): Promise<string | null> => {
    const f = await open({
      multiple: false,
      filters: [{ name: "可打开的文件", extensions: ["txt", "zip", ...extraExts] }],
    });
    return typeof f === "string" ? f : null;
  },
  pickDirectory: async (): Promise<string | null> => {
    const d = await open({ directory: true, multiple: false });
    return typeof d === "string" ? d : null;
  },
  pickSaveFile: async (defaultName: string): Promise<string | null> => {
    const f = await save({
      defaultPath: defaultName,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    return typeof f === "string" ? f : null;
  },
  pickPluginFile: async (): Promise<string | null> => {
    const f = await open({
      multiple: false,
      filters: [{ name: "ReadBook 插件包", extensions: ["rbplugin", "zip"] }],
    });
    return typeof f === "string" ? f : null;
  },
};
