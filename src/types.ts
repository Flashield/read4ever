/* 共享类型定义（与后端 Rust 结构对应） */

export interface CustomTheme {
  name: string;
  bg: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
}

/* 标签页持久化描述（惰性：重启后激活 tab 立即打开，后台 tab 首次点击才加载） */
export interface TabDescriptor {
  path: string; // 打开的文件（zip 为复合路径；插件文件即其路径）
  ratio: number; // 文本滚动位置 0..1
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
  keepAwake: boolean; // 滚屏/定时翻页/插件播放时保持屏幕常亮（阻止屏保/待机）
  activeKeywordGroupId: string; // 当前使用的关键词组
  lastFolderPath: string; // 上次打开的文件夹（文件夹侧栏恢复用）
  folderAutoOpen: boolean; // 启动时自动打开文件夹侧栏
  folderListRecursive: boolean; // 文件夹侧栏列表是否含子目录
  smbListRecursive: boolean; // 远程列表是否含子目录
  smbListDepth: number; // 远程递归下钻层数（1–5，0=不限）
  naturalSort: boolean; // 文件名自然排序（侧栏列表与上一个/下一个导航统一）
  plugins: Record<string, boolean>; // 插件启用状态（未列出的默认启用）
  pluginSettings: Record<string, Record<string, number | boolean | string>>; // 插件固定设置
  folderTab: string; // 文件夹侧栏当前标签："" 本地 / "smb" 远程
  bookshelfActiveId: string; // 书架面板当前书架（失效时回退第一个）
  openInNewTab: boolean; // 手动打开文件默认新标签页
  tabSwitchPlayback: string; // "pause" | "continue"：切换标签页时后台媒体
  tabLimit: number; // 标签页数量上限
  allowMultipleInstances: boolean; // 允许同时运行多个程序实例（重启后生效）
  tabs: TabDescriptor[]; // 启动恢复用标签页描述（惰性重建）
  activeTabIndex: number; // 启动恢复时激活的 tab 下标
}

/* SMB 远程服务器配置（对应后端 SmbServer；username 空 = 访客） */
export interface SmbServer {
  id: string; // 稳定短 id，规范路径 smb://<id>/share/… 用它引用
  name: string;
  host: string; // 主机名或 IP（可带 :端口，默认 445）
  share: string; // 共享名
  workgroup: string;
  username: string;
  password: string;
}

/* 文件夹侧栏的目录条目（对应后端 FileEntry） */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/* SMB 远程目录条目：FileEntry + 本地缓存标记（对应后端 SmbFileEntry） */
export interface SmbFileEntry extends FileEntry {
  cached: boolean; // 本地缓存存在且新鲜
}

/* SMB 单文件缓存状态（对应后端 SmbCacheStatus） */
export interface SmbCacheStatus {
  cached: boolean; // 本地副本存在（哪怕过期）
  fresh: boolean; // 与远程 size+mtime 一致
  bytes: number; // 本地副本字节数
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
  tags: string[]; // 标签（书架面板快速筛选）
}

/* 收藏书架：多书架，条目嵌套归属 */
export interface Bookshelf {
  id: string;
  name: string;
  items: BookshelfItem[];
}

export interface StoreData {
  settings: Settings;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  bookshelves: Bookshelf[];
  keywordGroups: KeywordGroup[];
  smbServers: SmbServer[];
}

export interface FileContent {
  content: string;
  encoding: string;
  fileName: string;
  filePath: string;
  isHardLines: boolean;
  note?: string; // 附加提示（如 SMB 离线兜底打开时说明内容可能过期）
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

/* 外部插件包（.rbplugin）的 manifest 信息（对应后端 PluginPkgInfo） */
export interface PluginPkgInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** 要求的宿主插件 API 大版本（当前为 1） */
  api: number;
  /** 入口文件（包内相对路径，默认 main.js） */
  entry: string;
  /** 可接管的扩展名（小写、含点） */
  extensions: string[];
  /** 安装目录 */
  dir: string;
}
