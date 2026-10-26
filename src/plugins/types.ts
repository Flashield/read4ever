/* 插件接口定义：内置模块插件与外部 .rbplugin 包共用，按扩展名接管文件打开。
   外部插件是独立打包的单文件 ESM，不能 import 宿主模块——
   宿主能力（读字节/设置/提示/状态上报）全部经由 PluginOpenContext 递入。 */
import type { MenuItemDef } from "../dropdown";

/** 插件视图状态：接管主窗口标题栏/右上角文件名与状态栏四格。
 *  插件视图关闭时宿主自动恢复文本阅读的状态，无需插件处理。 */
export interface PluginViewStatus {
  /** 右上角文件名与窗口标题（如 "插图01.png"）；未上报时宿主显示文件名 */
  title?: string;
  /** 状态栏第一格原文（如 "PNG 1280×720"），未上报显示 "-" */
  encoding?: string;
  /** 状态栏第二格原文（如 "第 2/35 张"） */
  position?: string;
  /** 状态栏第三格原文（如 "模式: 适应窗口"） */
  mode?: string;
  /** 状态栏第四格原文（如 "滚屏中·向下"） */
  display?: string;
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
  /** 同目录/同压缩包内同类型文件（按名称排序），供上一个/下一个翻页 */
  siblings: string[];
  /** 当前文件在 siblings 中的下标 */
  siblingIndex: number;
  /** 读取文件字节（自动区分磁盘文件与 zip 条目）。
   *  安全边界：仅允许当前打开文件所在目录/压缩包内的路径，越界路径拒绝。 */
  loadBytes(path: string): Promise<Uint8Array>;
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
}

export interface ReadBookPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 可接管的扩展名（小写、含点），如 ".png" */
  extensions: string[];
  /** 打开文件：把视图渲染到 ctx.host */
  open(ctx: PluginOpenContext): void | Promise<void>;
  /** 视图被关闭/切走时的清理（如 revoke Blob URL） */
  deactivate?(): void;
  /** 插件固定设置菜单项（启用时显示在菜单栏"插件"菜单中） */
  menu?(): MenuItemDef[];
}
