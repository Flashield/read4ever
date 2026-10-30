/* 插件接口定义：内置模块插件与外部 .rbplugin 包共用，按扩展名接管文件打开。
   外部插件是独立打包的单文件 ESM，不能 import 宿主模块——
   宿主能力（读字节/设置/提示/状态上报）全部经由 PluginOpenContext 递入。 */
import type { MenuItemDef } from "../dropdown";

/** 插件视图状态：接管主窗口标题栏/右上角文件名与状态栏各格。
 *  插件视图关闭时宿主自动恢复文本阅读的状态，无需插件处理。 */
export interface PluginViewStatus {
  /** 打开的文件名与窗口标题（如 "画册.zip"）；未上报时宿主显示打开的文件名 */
  title?: string;
  /** 状态栏"文件"格：当前查看的文件名（如 zip 内当前条目 "插图01.png"）；未上报时显示打开的文件名 */
  file?: string;
  /** 状态栏"编码"格原文（如 "PNG 1280×720"），未上报显示 "-" */
  encoding?: string;
  /** 状态栏"位置"格原文（如 "第 2/35 张"） */
  position?: string;
  /** 状态栏"模式"格原文（如 "模式: 适应窗口"） */
  mode?: string;
  /** 状态栏"显示"格原文（如 "滚屏中·向下"） */
  display?: string;
}

/** 插件视图实例：多标签页下每个 tab 可持有独立实例（内置插件以类实现）。
 *  旧单例接口的外部插件由宿主 wrapSingleton 包装，无需改动。 */
export interface PluginViewInstance {
  /** 打开文件：把视图渲染到 ctx.host（实例面板） */
  open(ctx: PluginOpenContext): void | Promise<void>;
  /** 视图销毁（tab 关闭/插件停用）：释放全部资源（Blob URL/定时器/监听器） */
  deactivate(): void;
  /** 仅激活 tab 的实例接收全局事件（键盘等）；后台实例挂起 */
  setActive?(on: boolean): void;
  /** 播放/暂停切换（可选）：宿主「滚屏/播放」公共入口调用 */
  togglePlay?(): void;
  /** 上一个/下一个文件（可选，delta 为 -1 或 1） */
  navFile?(delta: number): void;
  /** 是否播放中（可选） */
  isPlaying?(): boolean;
}

/** 插件打开文件的上下文 */
export interface PluginOpenContext {
  /** 完整路径（zip 内条目为「zip路径::条目名」复合路径） */
  path: string;
  /** 文件名（zip 条目为条目名） */
  name: string;
  /** 小写扩展名（含点） */
  ext: string;
  /** 文件原始字节 */
  bytes: Uint8Array;
  /** 视图宿主：插件把 DOM 渲染进这个容器，激活期间覆盖阅读区 */
  host: HTMLElement;
  /** 本视图实例 id（媒体坞会话 id / 常亮来源后缀，由宿主分配） */
  viewId: string;
  /** 关闭本视图（等同用户点关闭：tab 回退文本层） */
  closeView(): void;
  /** 同目录/同压缩包内同类型文件（按名称排序），供上一个/下一个翻页 */
  siblings: string[];
  /** 当前文件在 siblings 中的下标 */
  siblingIndex: number;
  /** 读取文件字节（自动区分磁盘文件与 zip 条目）。
   *  安全边界：仅允许当前打开文件所在目录/压缩包内的路径，越界路径拒绝。 */
  loadBytes(path: string): Promise<Uint8Array>;
  /** 本地文件、本地 zip 存储型条目与 SMB 远程普通文件的流式播放 URL（readbook-stream://，
   *  宿主按 HTTP Range 分块响应）——声明 wantsStream 的插件播放大文件用。
   *  SMB 远程 zip 复合路径与浏览器演示环境返回 null，调用方回退 loadBytes 整读。 */
  streamUrlFor?(path: string): string | null;
  /** 列出当前文件所在容器（目录或 zip）的全部条目：
   *  zip 返回条目名（含子路径），目录返回文件完整路径（含子目录文件）。 */
  listContainer(): Promise<string[]>;
  /** 上报视图状态：改写右上角文件名/窗口标题与状态栏四格。
   *  传入的是增量——只更新给出的字段，未传字段保持上次值。 */
  setStatus(status: PluginViewStatus): void;
  /** 读插件固定设置（持久化于宿主设置，按插件 id 隔离） */
  getSetting<T>(key: string, def: T): T;
  /** 写插件固定设置并持久化 */
  setSetting(key: string, value: string | number | boolean): void;
  /** 轻提示：屏幕下方短暂浮出一行文字 */
  toast(text: string): void;
  /** 持有/释放屏幕常亮（滚屏、幻灯、视频播放等场景）。幂等；
   *  视图关闭时宿主自动释放插件持有的常亮，忘关不会永久常亮。
   *  同一插件连续打开下一个文件（上一/下一张）时不自动释放，由插件在 open 中自行调用 setKeepAwake(false) 重置。 */
  setKeepAwake(on: boolean): void;
  /** 触发宿主「滚屏/播放」公共入口（等同菜单栏滚屏按钮 / Space 键）：
   *  宿主按当前视图分发——插件视图回调本插件的 togglePlay（若实现），文本视图开关滚屏 */
  togglePlayback(): void;
}

export interface ReadBookPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 可接管的扩展名（小写、含点），如 ".png" */
  extensions: string[];
  /** 声明后宿主跳过整文件字节预读，改经 ctx.streamUrlFor 提供本地文件与 SMB 普通文件的流式 URL
   *  （2GB+ 媒体必需；本地 zip 条目为存储型时同样支持，远程 zip 复合路径与压缩条目由插件自行回退整读） */
  wantsStream?: boolean;
  /** 声明后本插件的视图实例豁免两处后台暂停:切标签页暂停策略(tabs.applyPlaybackPolicy)
   *  与进托盘全停(registry.pauseAllInstances)。音频「边听边看/托盘继续听」用 */
  backgroundPlayback?: boolean;
  /** 动态豁免进托盘全停（registry.pauseAllInstances 每次进托盘现读）：
   *  与静态 backgroundPlayback 叠加、不影响切标签页策略。视频「最小化托盘仍播放」设置用 */
  trayPlaybackExempt?: () => boolean;
  /** 视图实例工厂（可选）：实现即支持多实例（每个 tab 独立视图）。
   *  未实现时宿主以单例方式包装（同时只有一个视图，行为同旧版） */
  createView?(): PluginViewInstance;
  /** 打开文件（单例接口）：把视图渲染到 ctx.host。
   *  实现 createView 的多实例插件可省略（视图逻辑在实例的 open 中） */
  open?(ctx: PluginOpenContext): void | Promise<void>;
  /** 实例被销毁时的清理（如 revoke Blob URL）；切走标签页只转后台保活，不调用本方法 */
  deactivate?(): void;
  /** 播放/暂停切换（可选）：宿主「滚屏/播放」公共入口在插件视图激活时调用。
   *  图片类：按上次选择的模式（滚屏或幻灯）开始，播放中则全部停止；
   *  视频类：暂停/继续。未实现时宿主提示"不支持播放控制" */
  togglePlay?(): void;
  /** 上一个/下一个文件（可选，delta 为 -1 或 1）：宿主「上一个/下一个文件」按钮在插件视图激活时调用。
   *  图片类为上一张/下一张（跨目录/压缩包接续），视频类为上一个/下一个视频 */
  navFile?(delta: number): void;
  /** 是否播放中（可选）：宿主按钮/菜单文案与工具栏按钮高亮同步用 */
  isPlaying?(): boolean;
  /** 插件固定设置菜单项（启用时显示在菜单栏"插件"菜单中） */
  menu?(): MenuItemDef[];
}
