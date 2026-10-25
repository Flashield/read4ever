/* 共享类型定义（与后端 Rust 结构对应） */

export interface CustomTheme {
  name: string;
  bg: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
}

export interface Settings {
  themeName: string;
  customThemes: CustomTheme[];
  customBg: string; // 未保存为方案时的自定义背景色（themeName === "自定义"）
  customText: string; // 同上的自定义文字颜色
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  scrollSpeed: number;
  scrollMode: string; // "continuous" | "page"
  pageInterval: number; // 秒
  displayMode: string; // "auto" | "simplified" | "traditional"
  dualPage: boolean;
  lastFilePath: string;
  lastScroll: number;
  autoRestore: boolean;
  activeKeywordGroupId: string; // 当前使用的关键词组
  lastFolderPath: string; // 上次打开的文件夹（文件夹侧栏恢复用）
  folderAutoOpen: boolean; // 启动时自动打开文件夹侧栏
  folderListRecursive: boolean; // 文件夹侧栏列表是否含子目录
  plugins: Record<string, boolean>; // 插件启用状态（未列出的默认启用）
  pluginSettings: Record<string, Record<string, number | boolean | string>>; // 插件固定设置
}

/* 文件夹侧栏的目录条目（对应后端 FileEntry） */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/* 关键词组：多个关键词组成一组，检索/统计以组为单位 */
export interface KeywordGroup {
  id: string;
  name: string;
  keywords: string[];
}

export interface Bookmark {
  filePath: string;
  position: number; // scroll 比例 0..1
  description: string;
  created: string;
}

export interface HistoryEntry {
  filePath: string;
  fileName: string;
  position: number;
  encoding: string;
  lastRead: string;
  readSeconds: number;
}

export interface BookshelfItem {
  filePath: string;
  name: string;
  added: string;
}

export interface StoreData {
  settings: Settings;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  bookshelf: BookshelfItem[];
  keywordGroups: KeywordGroup[];
}

export interface FileContent {
  content: string;
  encoding: string;
  fileName: string;
  filePath: string;
  isHardLines: boolean;
}

export interface OpenFile {
  filePath: string; // 实际路径，zip 则是 zip::entry
  zipPath?: string; // zip 文件路径
  zipEntry?: string; // zip 内部条目
}

/* 拖拽打开的文件数据 */
export interface DragFilePayload {
  paths: string[];
}
