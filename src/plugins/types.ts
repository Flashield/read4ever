/* 插件接口定义：内置模块插件，按扩展名接管文件打开 */
import type { MenuItemDef } from "../dropdown";

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
  /** 读取任意文件字节（自动区分磁盘文件与 zip 条目） */
  loadBytes(path: string): Promise<Uint8Array>;
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
