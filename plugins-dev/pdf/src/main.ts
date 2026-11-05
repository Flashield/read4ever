/* PDF 阅读插件：pdf.js 渲染 PDF 注入插件视图宿主（原样渲染，不跟随主题）。
   worker 以 blob 方式内联自启动（不依赖宿主 vite 配置），自包含单文件 ESM。 */
import "./shims"; // 必须最先 import：垫片先于 pdfjs-dist 模块体求值
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import workerText from "../dist/pdf.worker.min.mjs.txt";

const PID = "pdf";

let workerUrl = ""; // 模块级复用：worker 从 blob 实例化后 URL 即无存在必要，保留给后续打开复用

/* pdf.js 6.5 直接依赖 2025 年新入库的 ES 方法（Map upsert、Uint8Array 二进制扩展、
   Promise.withResolvers、Set.intersection）且不带垫片，旧内核没有会整体解析失败——
   以 prologue 前置进 worker blob 补齐（与 src/shims.ts 同一组垫片，保持同步）。 */
const WORKER_PROLOGUE = `
function rbUpsert(p){Object.assign(p,{getOrInsert:function(k,v){if(!this.has(k))this.set(k,v);return this.get(k)},getOrInsertComputed:function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)}})}
if(!Map.prototype.getOrInsert)rbUpsert(Map.prototype);
if(!WeakMap.prototype.getOrInsert)rbUpsert(WeakMap.prototype);
if(!Uint8Array.prototype.toHex){Uint8Array.prototype.toHex=function(){let s='';for(const b of this)s+=b.toString(16).padStart(2,'0');return s}}
if(!Uint8Array.prototype.toBase64){Uint8Array.prototype.toBase64=function(){let s='';for(let i=0;i<this.length;i+=32768)s+=String.fromCharCode.apply(null,this.subarray(i,i+32768));return btoa(s)}}
if(!Uint8Array.fromBase64){Uint8Array.fromBase64=function(s){const b=atob(String(s).replace(/\\s+/g,''));const o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o}}
if(!Set.prototype.intersection){Set.prototype.intersection=function(o){const t=this.size<=o.size?this:o,b=t===this?o:this,n=new Set();for(const v of t)if(b.has(v))n.add(v);return n}}
if(!Promise.withResolvers){Promise.withResolvers=function(){let r,j;const p=new Promise(function(a,b){r=a;j=b});return{promise:p,resolve:r,reject:j}}}
`;

/** worker 以 blob 自启动（同源 blob URL 直接可用，无需宿主任何资源路径） */
function ensureWorker(): void {
  if (!workerUrl)
    workerUrl = URL.createObjectURL(new Blob([WORKER_PROLOGUE + workerText], { type: "text/javascript" }));
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

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
  private scroll!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private renderTask: RenderTaskLike | null = null;
  private resizeTimer = 0;
  private resizeOb: ResizeObserver | null = null; // 滚动容器尺寸变化驱动重适宽（宿主激活 0→宽、窗口缩放）
  active = true; // 公开：noUnusedLocals 拒收只写私有字段（同 EPUB 约定）

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.active = true;
    ctx.setStatus({
      title: ctx.name,
      file: ctx.name,
      encoding: "PDF",
      position: "解析中…",
      mode: "模式: 适宽",
      display: "-",
    });
    ensureWorker();
    try {
      // data 会转移 TypedArray 所有权，传副本保住 ctx.bytes
      this.loadTask = pdfjsLib.getDocument({ data: ctx.bytes.slice() });
      this.pdf = await this.loadTask.promise;
      const meta = await this.pdf.getMetadata();
      this.version = (meta.info as { PDFFormatVersion?: string }).PDFFormatVersion || "";
    } catch (e) {
      this.pdf = null;
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
      encoding: this.version ? `PDF ${this.version}` : "PDF",
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
    void this.loadTask?.destroy();
    this.loadTask = null;
    this.pdf = null;
  }
}

/* 单实例语义（同 EPUB 单例用法）：插件对象必带 open（loader 校验），状态由模块级视图承载，
   同插件再打开时宿主先销毁旧视图再走 open */
const view = new PdfView();

const plugin: Read4EverPlugin = {
  id: PID,
  name: "PDF 阅读器",
  version: "0.1.0",
  description: "PDF 阅读：pdf.js 连续滚屏渲染、适宽显示，速度键与 Space 经宿主滚屏引擎可用",
  extensions: [".pdf"],
  open: (ctx) => view.open(ctx),
  togglePlay: () => view.togglePlay(),
  isPlaying: () => view.isPlaying(),
  deactivate: () => view.deactivate(),
};

export default plugin;
