/* PDF 阅读插件：pdf.js 渲染 PDF 注入插件视图宿主（原样渲染，不跟随主题）。
   来源矩阵（探索笔记 04）：流式 URL 可达 → read4ever-stream:// Range 流式（大文件不整读，
   disableAutoFetch 按需分块）；不可达（浏览器 mock / SMB zip 复合路径）→ ctx.bytes 整读；
   流式探针/加载失败 → loadBytes 整读回退。整读路径过大小防线（超 256MB 报错、
   超 1GB 提示先缓存到本地）。 */
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import { fullReadSizeError } from "./stream";
import { openStreamed } from "./transport";
import { ensureWorker } from "./worker";

const PID = "pdf";

/** 渲染任务的结构化最小类型（页.render 返回对象即可赋值） */
interface RenderTaskLike {
  cancel(): void;
  promise: Promise<void>;
}

const VIEW_CSS = `
.rbpdf-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 7; display: flex; align-items: center; gap: 8px; padding: 4px 10px; height: 30px; box-sizing: border-box; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-bottom: 1px solid var(--ui-border, #555); font-size: 13px; }
.rbpdf-title { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rbpdf-scroll { position: absolute; inset: 30px 0 0 0; overflow: auto; outline: none; background: var(--panel-bg, #1e1e1e); }
.rbpdf-canvas { display: block; margin: 12px auto; background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45); }
`;

class PdfView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private pdf: PDFDocumentProxy | null = null;
  private loadTask: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } | null =
    null; // v6 起销毁走加载任务
  private version = ""; // PDF 版本号（getMetadata 的 PDFFormatVersion）
  private streamed = false; // 本次打开走了流式路径（状态栏「编码」格标注）
  private scroll!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private renderTask: RenderTaskLike | null = null;
  private resizeTimer = 0;
  private resizeOb: ResizeObserver | null = null; // 滚动容器尺寸变化驱动重适宽（宿主激活 0→宽、窗口缩放）
  active = true; // 公开：noUnusedLocals 拒收只写私有字段（同 EPUB 约定）

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.active = true;
    this.streamed = false;
    ctx.setStatus({
      title: ctx.name,
      file: ctx.name,
      encoding: "PDF",
      position: "解析中…",
      mode: "模式: 适宽",
      display: "-",
    });
    ensureWorker();
    /* 数据路径分叉（探索笔记 04）：streamUrlFor 存在 ⇔ wantStream ⇔ ctx.bytes 为空。
       有 URL 走 Range 流式，探针/加载失败回退整读（loadBytes）；无 URL（mock /
       SMB zip 复合）ctx.bytes 已是完整字节。 */
    const streamUrl = ctx.streamUrlFor?.(ctx.path);
    try {
      if (typeof streamUrl === "string") {
        try {
          const doc = await openStreamed(streamUrl);
          this.loadTask = doc.task;
          this.pdf = doc.pdf;
          this.streamed = true;
        } catch {
          this.cleanupLoadTask();
          // 流式不可达：回退整读（本地 zip 压缩条目 404 / SMB 故障 / 协议异常）
          if (!(await this.openFullRead(ctx, true))) return; // 防线拦截：已提示并关视图
        }
      } else if (!(await this.openFullRead(ctx, false))) {
        return; // 防线拦截：已提示并关视图
      }
      const meta = await this.pdf!.getMetadata();
      this.version = (meta.info as { PDFFormatVersion?: string }).PDFFormatVersion || "";
    } catch (e) {
      this.cleanupLoadTask();
      ctx.toast(`PDF 解析失败：${String(e).slice(0, 80)}`);
      ctx.closeView();
      return;
    }
    this.buildDom();
    // 滚屏引擎挂到滚动容器：速度键/Space 经宿主 togglePlayback 递入；到末尾引擎自停并回调
    this.ctx.autoscroll.attach(this.scroll, {
      onEnd: () => {
        this.ctx.toast("已读到末尾");
        this.syncStatus();
      },
    });
    await this.renderFit();
  }

  /** 整读打开（wantStream 路径 ctx.bytes 为空，须 loadBytes）。
      返回 false = 大小防线拦截（已 toast 文案并 closeView） */
  private async openFullRead(ctx: PluginOpenContext, viaLoadBytes: boolean): Promise<boolean> {
    const bytes = viaLoadBytes ? await ctx.loadBytes(ctx.path) : ctx.bytes;
    const oversize = fullReadSizeError(bytes.length);
    if (oversize) {
      ctx.toast(oversize);
      ctx.closeView();
      return false;
    }
    // data 会转移 TypedArray 所有权，传副本保住 ctx.bytes
    this.loadTask = pdfjsLib.getDocument({ data: bytes.slice() });
    this.pdf = await this.loadTask.promise;
    return true;
  }

  /** 销毁失败的加载任务并清引用（流式回退/解析失败/视图关闭共用） */
  private cleanupLoadTask(): void {
    const task = this.loadTask;
    this.loadTask = null;
    this.pdf = null;
    if (task) void task.destroy().catch(() => {});
  }

  private buildDom(): void {
    const host = this.ctx.host;
    const style = document.createElement("style");
    style.textContent = VIEW_CSS;
    const bar = document.createElement("div");
    bar.className = "rbpdf-bar plugin-topbar"; // 沉浸全屏自动吸附
    const title = document.createElement("span");
    title.className = "rbpdf-title";
    title.textContent = this.ctx.name;
    bar.append(title);
    this.scroll = document.createElement("div");
    this.scroll.className = "rbpdf-scroll";
    this.scroll.tabIndex = 0;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "rbpdf-canvas";
    this.scroll.appendChild(this.canvas);
    host.append(style, bar, this.scroll);
    this.resizeOb = new ResizeObserver(this.onResize);
    this.resizeOb.observe(this.scroll);
  }

  /** 首页适宽渲染（devicePixelRatio 缩放保清晰；页边距 12px×2） */
  private async renderFit(): Promise<void> {
    if (!this.pdf) return;
    const page = await this.pdf.getPage(1);
    this.renderTask?.cancel();
    const base = page.getViewport({ scale: 1 });
    const cssW = Math.max(120, this.scroll.clientWidth - 24);
    const scale = cssW / base.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale });
    this.canvas.width = Math.floor(viewport.width * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.canvas.style.height = `${Math.floor(viewport.height)}px`;
    const task = page.render({
      canvas: this.canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e instanceof pdfjsLib.RenderingCancelledException) return;
      throw e;
    }
    this.syncStatus();
  }

  /** 宿主激活（0→实际宽）或窗口尺寸变化后自动重适宽（保持页内滚动比） */
  private onResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => void this.refit(), 150);
  };

  private async refit(): Promise<void> {
    if (!this.pdf || !this.active) return;
    if (this.scroll.clientWidth < 60) return; // 宿主尚隐藏（display:none）：无意义布局不渲染
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const ratio = max > 0 ? this.scroll.scrollTop / max : 0;
    await this.renderFit();
    const nm = this.scroll.scrollHeight - this.scroll.clientHeight;
    if (nm > 0) this.scroll.scrollTop = ratio * nm;
  }

  private syncStatus(): void {
    this.ctx.setStatus({
      title: this.ctx.name,
      file: this.ctx.name,
      encoding: this.version ? `PDF ${this.version}${this.streamed ? " 流式" : ""}` : "PDF",
      position: `第 1/${this.pdf?.numPages ?? "?"} 页`,
      mode: "模式: 适宽",
      display: this.ctx.autoscroll.isScrolling() ? "滚屏中" : "-",
    });
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  /** Space 暂停/继续（宿主 togglePlayback 分发到本插件） */
  togglePlay(): void {
    this.ctx.autoscroll.toggle();
  }

  isPlaying(): boolean {
    return this.ctx.autoscroll.isScrolling();
  }

  deactivate(): void {
    this.active = false;
    window.clearTimeout(this.resizeTimer);
    this.resizeOb?.disconnect();
    this.resizeOb = null;
    this.ctx.autoscroll.detach();
    this.renderTask?.cancel();
    this.renderTask = null;
    this.cleanupLoadTask();
  }
}

/* 单实例语义（同 EPUB 单例用法）：插件对象必带 open（loader 校验），状态由模块级视图承载，
   同插件再打开时宿主先销毁旧视图再走 open */
const view = new PdfView();

const plugin: Read4EverPlugin = {
  id: PID,
  name: "PDF 阅读器",
  version: "0.1.0",
  description: "PDF 阅读：pdf.js 连续滚屏渲染、适宽显示、大文件 Range 流式加载，速度键与 Space 经宿主滚屏引擎可用",
  extensions: [".pdf"],
  wantsStream: true, // 宿主跳过字节预读（ctx.bytes 置空），经 ctx.streamUrlFor 走流式；回退整读见 open()
  open: (ctx) => view.open(ctx),
  togglePlay: () => view.togglePlay(),
  isPlaying: () => view.isPlaying(),
  deactivate: () => view.deactivate(),
};

export default plugin;
