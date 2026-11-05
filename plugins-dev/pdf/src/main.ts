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
.rbpdf-bar button { border: 1px solid var(--ui-border, #555); background: var(--ui-bg, #2b2b2b); color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; font: inherit; }
.rbpdf-bar button:hover { background: var(--ui-hover, #3d3d3d); }
.rbpdf-pageno { width: 44px; text-align: center; border: 1px solid var(--ui-border, #555); background: var(--ui-bg, #2b2b2b); color: inherit; border-radius: 6px; padding: 2px 4px; font: inherit; }
.rbpdf-ptotal { opacity: 0.75; white-space: nowrap; }
.rbpdf-zoom-label { min-width: 44px; text-align: center; opacity: 0.85; white-space: nowrap; }
.rbpdf-title { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rbpdf-scroll { position: absolute; inset: 30px 0 0 0; overflow: auto; outline: none; background: var(--panel-bg, #1e1e1e); display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 12px 0; }
.rbpdf-page { position: relative; flex: none; margin: 0 auto; overflow: hidden; background: #d9d9d9; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45); }
.rbpdf-page canvas { display: block; background: #fff; }
`;

class PdfView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private pdf: PDFDocumentProxy | null = null;
  private loadTask: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } | null =
    null; // v6 起销毁走加载任务
  private version = ""; // PDF 版本号（getMetadata 的 PDFFormatVersion）
  private scroll!: HTMLElement;
  private pageDims: { w: number; h: number }[] = []; // 每页 scale=1 视口尺寸（占位几何来源）
  private pages: HTMLDivElement[] = []; // 占位序列（固定尺寸，canvas 进出其中）
  private tops: number[] = []; // 占位顶部 y（含 12px 页边距），布局真值的 JS 副本免逐帧读 DOM
  private cssW = 0; // 当前适宽页宽
  private states = new Uint8Array(0); // 每页渲染态：0 空 1 排队 2 渲染中 3 完成
  private renderGen: number[] = []; // 每页在途渲染令牌（回收/重排作废在途提交）
  private canvases = new Map<number, { el: HTMLCanvasElement; task: RenderTaskLike | null }>();
  private queue: number[] = []; // 待渲染页（离视口中心近者优先），每次 update 整体重建
  private pumping = 0; // 在途渲染数（并发上限 2）
  private taskSeq = 0; // 渲染任务自增令牌
  private rafId = 0;
  private maxAlive = 10; // 同时存在渲染层的硬上界（可视页 ±2 缓冲之外再兜底）
  private resizeTimer = 0;
  private resizeOb: ResizeObserver | null = null; // 滚动容器尺寸变化驱动重适宽（宿主激活 0→宽、窗口缩放）
  private zoomMode: "fit" | "percent" = "fit"; // 缩放模式：适宽（默认）或百分比
  private zoom = 1; // 百分比模式的缩放因子（1 = 100%），步进 ×1.15，钳位 0.2~5
  private pageInput!: HTMLInputElement; // 页码输入（回车跳页）
  private pageTotal!: HTMLElement; // 总页数标签
  private zoomLabel!: HTMLElement; // 缩放状态标签（适宽 / 115%）
  private hostEl: HTMLElement | null = null; // 键盘监听挂宿主 pane：工具栏点击后焦点不出视图
  private static readonly ZOOM_MIN = 0.2;
  private static readonly ZOOM_MAX = 5;
  private static readonly ZOOM_STEP = 1.15;
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
    await this.buildPages();
    // 滚屏引擎挂到滚动容器：速度键/Space 经宿主 togglePlayback 递入；到末尾引擎自停并回调
    this.ctx.autoscroll.attach(this.scroll, {
      onEnd: () => {
        this.ctx.toast("已读到末尾");
        this.syncStatus();
      },
    });
    this.update();
  }
  private buildDom(): void {
    const host = this.ctx.host;
    const style = document.createElement("style");
    style.textContent = VIEW_CSS;
    const bar = document.createElement("div");
    bar.className = "rbpdf-bar plugin-topbar"; // 沉浸全屏自动吸附
    // 页码导航：上一页 / 页码输入 / 总页数 / 下一页（列首对齐翻页，见 gotoPage）
    const prev = document.createElement("button");
    prev.className = "rbpdf-prev";
    prev.title = "上一页";
    prev.textContent = "◀";
    prev.addEventListener("click", () => {
      this.gotoPage(this.currentPage() - 1);
      this.scroll.focus();
    });
    this.pageInput = document.createElement("input");
    this.pageInput.className = "rbpdf-pageno";
    this.pageInput.type = "text";
    this.pageInput.inputMode = "numeric";
    this.pageInput.title = "页码，回车跳转";
    this.pageInput.value = "1";
    this.pageInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = parseInt(this.pageInput.value, 10);
      if (Number.isFinite(v)) this.gotoPage(v); // 非数字忽略；超界在 gotoPage 内 clamp
      this.pageInput.blur();
      this.scroll.focus();
    });
    this.pageTotal = document.createElement("span");
    this.pageTotal.className = "rbpdf-ptotal";
    this.pageTotal.textContent = "/ ?";
    const next = document.createElement("button");
    next.className = "rbpdf-next";
    next.title = "下一页";
    next.textContent = "▶";
    next.addEventListener("click", () => {
      this.gotoPage(this.currentPage() + 1);
      this.scroll.focus();
    });
    const title = document.createElement("span");
    title.className = "rbpdf-title";
    title.textContent = this.ctx.name;
    // 缩放：− / 标签 / ＋ / 适宽 / 100%
    const zout = document.createElement("button");
    zout.className = "rbpdf-zout";
    zout.title = "缩小";
    zout.textContent = "−";
    zout.addEventListener("click", () => {
      this.zoomBy(1 / PdfView.ZOOM_STEP);
      this.scroll.focus();
    });
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "rbpdf-zoom-label";
    this.zoomLabel.textContent = "适宽";
    const zin = document.createElement("button");
    zin.className = "rbpdf-zin";
    zin.title = "放大";
    zin.textContent = "+";
    zin.addEventListener("click", () => {
      this.zoomBy(PdfView.ZOOM_STEP);
      this.scroll.focus();
    });
    const fit = document.createElement("button");
    fit.className = "rbpdf-fit";
    fit.title = "适宽";
    fit.textContent = "适宽";
    fit.addEventListener("click", () => {
      this.applyZoom("fit");
      this.scroll.focus();
    });
    const z100 = document.createElement("button");
    z100.className = "rbpdf-z100";
    z100.title = "原始大小";
    z100.textContent = "100%";
    z100.addEventListener("click", () => {
      this.applyZoom("percent", 1);
      this.scroll.focus();
    });
    bar.append(prev, this.pageInput, this.pageTotal, next, title, zout, this.zoomLabel, zin, fit, z100);
    this.scroll = document.createElement("div");
    this.scroll.className = "rbpdf-scroll";
    this.scroll.tabIndex = 0;
    this.scroll.addEventListener("scroll", this.onScroll, { passive: true });
    this.scroll.addEventListener("wheel", this.onWheel); // Ctrl+滚轮缩放（preventDefault 挡浏览器页面缩放）
    host.append(style, bar, this.scroll);
    this.hostEl = host;
    host.addEventListener("keydown", this.onKey); // 挂 pane：工具栏/阅读区内焦点都能翻页
    this.resizeOb = new ResizeObserver(this.onResize);
    this.resizeOb.observe(this.scroll);
  }

  /** 收集每页尺寸并建占位序列（高度=页高×适宽缩放），布局总高一次到位——滚动中占位高度不动 */
  private async buildPages(): Promise<void> {
    const pdf = this.pdf;
    if (!pdf) return;
    const n = pdf.numPages;
    this.pageDims = [];
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      this.pageDims.push({ w: vp.width, h: vp.height });
      page.cleanup(); // 只留尺寸；渲染时再 getPage（pdf.js 自带页缓存）
    }
    const frag = document.createDocumentFragment();
    this.pages = [];
    for (let i = 0; i < n; i++) {
      const div = document.createElement("div");
      div.className = "rbpdf-page";
      frag.appendChild(div);
      this.pages.push(div);
    }
    this.scroll.appendChild(frag);
    this.renderGen = new Array(n).fill(-1);
    this.states = new Uint8Array(n);
    this.layout();
  }

  /** 第 i 页（0 起）的渲染/占位缩放：适宽 = 容器宽推导；百分比 = 固定因子（唯一缩放推导点，
      layout 与 renderPage 都经此取值，保证占位几何与 canvas 严格一致） */
  private scaleOf(i: number): number {
    const d = this.pageDims[i];
    if (!d || !d.w) return 1;
    return this.zoomMode === "fit" ? this.cssW / d.w : this.zoom;
  }

  /** 按当前缩放模式重排占位尺寸与 tops 前缀（打开/窗口变化/缩放时调用）。
      滚动容器为 flex 纵列 + gap 12 + 上下 padding 12：页间距不塌陷，tops 与 DOM 布局严格一致 */
  private layout(): void {
    if (this.zoomMode === "fit") this.cssW = Math.max(120, this.scroll.clientWidth - 24); // 页左右留 12px×2
    this.tops = [];
    let y = 12;
    for (let i = 0; i < this.pages.length; i++) {
      const d = this.pageDims[i];
      const s = this.scaleOf(i);
      const w = Math.round(d.w * s);
      const h = Math.round(d.h * s);
      this.pages[i].style.width = `${w}px`;
      this.pages[i].style.height = `${h}px`;
      this.tops.push(y);
      y += h + 12;
    }
  }

  /** 可视页定位：最后一个 tops[i] ≤ y 的页（夹在范围内） */
  private pageAt(y: number): number {
    const last = this.tops.length - 1;
    if (last < 0) return 0;
    let a = 0,
      b = last,
      r = 0;
    while (a <= b) {
      const m = (a + b) >> 1;
      if (this.tops[m] <= y) {
        r = m;
        a = m + 1;
      } else b = m - 1;
    }
    return r;
  }

  /** 滚动/布局变化后重算可视范围：回收缓冲外渲染层、入队缓冲内未渲染页、刷新状态栏页码 */
  private update(): void {
    if (!this.pdf || !this.pages.length) return;
    const st = this.scroll.scrollTop;
    const v0 = this.pageAt(st);
    const v1 = this.pageAt(st + this.scroll.clientHeight);
    const lo = Math.max(0, v0 - 2); // 可视页 ±2 缓冲
    const hi = Math.min(this.pages.length - 1, v1 + 2);
    for (const i of [...this.canvases.keys()]) if (i < lo || i > hi) this.reclaim(i);
    const center = st + this.scroll.clientHeight / 2;
    const want: number[] = [];
    for (let i = lo; i <= hi; i++) {
      if (this.states[i] === 0) this.states[i] = 1;
      if (this.states[i] === 1) want.push(i);
    }
    want.sort((a, b) => Math.abs(this.tops[a] - center) - Math.abs(this.tops[b] - center));
    // 硬上界兜底：可视页异常多时只留离视口中心最近的
    this.queue = want.slice(0, Math.max(0, this.maxAlive - this.canvases.size));
    this.pump();
    this.syncStatus();
  }

  private onScroll = (): void => {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.update();
    });
  };

  /** 启动待渲染队列，并发上限 2 */
  private pump(): void {
    while (this.pumping < 2 && this.queue.length > 0) {
      const i = this.queue.shift() as number;
      if (this.states[i] !== 1) continue;
      this.states[i] = 2;
      this.pumping++;
      void this.renderPage(i, ++this.taskSeq);
    }
  }

  /** 回收第 i 页渲染层（占位保留高度），作废在途渲染令牌 */
  private reclaim(i: number): void {
    const c = this.canvases.get(i);
    this.renderGen[i] = -1;
    if (this.states[i] !== 0) this.states[i] = 0;
    if (!c) return;
    c.task?.cancel();
    c.el.remove();
    this.canvases.delete(i);
  }

  /** 渲染第 i 页（0 起）进其占位（devicePixelRatio 缩放保清晰）；seq 作废即不提交 */
  private async renderPage(i: number, seq: number): Promise<void> {
    try {
      const pdf = this.pdf;
      const slot = this.pages[i];
      const d = this.pageDims[i];
      if (!pdf || !slot || !d) return;
      const page = await pdf.getPage(i + 1);
      if (this.states[i] !== 2) return; // 等待期间被回收
      if (this.renderGen[i] !== -1 && this.renderGen[i] !== seq) return; // 已有更新任务接管
      this.renderGen[i] = seq;
      const scale = this.scaleOf(i);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      slot.replaceChildren(canvas);
      const task = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      this.canvases.set(i, { el: canvas, task });
      try {
        await task.promise;
      } catch (e) {
        if (e instanceof pdfjsLib.RenderingCancelledException) return; // 回收路径已清场
        throw e;
      }
      if (this.renderGen[i] === seq) this.states[i] = 3;
    } finally {
      this.pumping--;
      this.pump();
    }
  }

  /** 宿主激活（0→实际宽）或窗口尺寸变化后自动重适宽（保持页内滚动比） */
  private onResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => void this.refit(), 150);
  };

  /** 清空全部渲染层与待渲染队列（refit/缩放共用：旧 canvas 尺寸不符须整体重渲染） */
  private clearRenders(): void {
    this.queue = [];
    for (const [i, c] of [...this.canvases]) {
      c.task?.cancel();
      c.el.remove();
      this.canvases.delete(i);
      this.renderGen[i] = -1;
    }
    this.states = new Uint8Array(this.pages.length);
  }

  private async refit(): Promise<void> {
    if (!this.pdf || !this.active) return;
    if (this.scroll.clientWidth < 60) return; // 宿主尚隐藏（display:none）：无意义布局不渲染
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const ratio = max > 0 ? this.scroll.scrollTop / max : 0;
    this.zoomMode = "fit"; // resize 回归适宽（AC：窗口尺寸变化后自动重新适宽）
    this.zoom = 1;
    this.clearRenders();
    this.layout();
    const nm = this.scroll.scrollHeight - this.scroll.clientHeight;
    if (nm > 0) this.scroll.scrollTop = ratio * nm;
    this.update();
  }

  /** 手动导航（跳页/翻页/缩放）前停掉自动滚屏：引擎每帧覆写 scrollTop，不停则操作看似失灵 */
  private manualNav(): void {
    if (this.ctx?.autoscroll.isScrolling()) this.ctx.autoscroll.stop();
  }

  /** 跳到第 p 页（1 起）：clamp 进页范围、滚动到该页顶（列首对齐）。
      文档未就绪（后台加载中）静默容错 */
  private gotoPage(p: number): void {
    const n = this.pdf?.numPages ?? 0;
    if (!n || !this.pages.length || !this.tops.length) return;
    const t = Math.min(n, Math.max(1, Math.round(p)));
    this.manualNav();
    this.scroll.scrollTop = this.tops[t - 1];
    this.update(); // 目标位置与当前一致时无 scroll 事件，主动刷新保证目标页入渲染池
  }

  /** 按因子步进缩放（工具栏 +/−）：以视口中心的当前页为基准求有效缩放后切换百分比模式 */
  private zoomBy(factor: number): void {
    if (!this.pdf || !this.pages.length) return;
    const i = this.pageAt(this.scroll.scrollTop + this.scroll.clientHeight / 2);
    const cur = this.scaleOf(i);
    const z = Math.min(PdfView.ZOOM_MAX, Math.max(PdfView.ZOOM_MIN, cur * factor));
    if (Math.abs(z - cur) < 1e-9) return; // 已在界限
    this.applyZoom("percent", z);
  }

  /** 应用缩放并保持锚点不漂移：ax/ay 是锚点视口坐标（Ctrl+滚轮传光标位置；按钮/复位为视口中心）。
      锚点所在页内取几何占比，重排后按新占位几何还原 scrollTop/scrollLeft——光标下内容保持不动 */
  private applyZoom(mode: "fit" | "percent", zoom = this.zoom, ax?: number, ay?: number): void {
    if (!this.pdf || !this.pages.length) return;
    const cx = ax ?? this.scroll.clientWidth / 2;
    const cy = ay ?? this.scroll.clientHeight / 2;
    const yc0 = this.scroll.scrollTop + cy;
    const i = this.pageAt(yc0);
    const d0 = this.pageDims[i];
    if (!d0) return;
    const s0 = this.scaleOf(i);
    const h0 = Math.max(1, Math.round(d0.h * s0));
    const w0 = Math.max(1, Math.round(d0.w * s0));
    const fracY = Math.min(1, Math.max(0, (yc0 - this.tops[i]) / h0));
    const left0 = Math.max(0, (this.scroll.clientWidth - w0) / 2);
    const fracX = Math.min(1, Math.max(0, (this.scroll.scrollLeft + cx - left0) / w0));
    this.manualNav();
    this.zoomMode = mode;
    if (mode === "percent") this.zoom = zoom;
    this.clearRenders();
    this.layout();
    const s1 = this.scaleOf(i);
    const h1 = Math.max(1, Math.round(d0.h * s1));
    const w1 = Math.max(1, Math.round(d0.w * s1));
    const left1 = Math.max(0, (this.scroll.clientWidth - w1) / 2);
    this.scroll.scrollTop = Math.max(0, this.tops[i] + fracY * h1 - cy);
    this.scroll.scrollLeft = Math.max(0, left1 + fracX * w1 - cx);
    this.update();
  }

  /** Ctrl+滚轮步进缩放，锚点=光标处内容；其余滚轮（含无修饰滚屏）不拦 */
  private onWheel = (e: WheelEvent): void => {
    if (!this.active || !e.ctrlKey || !this.pdf || !this.pages.length) return;
    e.preventDefault(); // 挡浏览器页面缩放
    const rect = this.scroll.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const i = this.pageAt(this.scroll.scrollTop + cy);
    const cur = this.scaleOf(i);
    const z = Math.min(
      PdfView.ZOOM_MAX,
      Math.max(PdfView.ZOOM_MIN, cur * (e.deltaY < 0 ? PdfView.ZOOM_STEP : 1 / PdfView.ZOOM_STEP)),
    );
    if (Math.abs(z - cur) < 1e-9) return; // 已在界限
    this.applyZoom("percent", z, cx, cy);
  };

  /** 键盘翻页（挂宿主 pane）：PgDn/→ 下一页、PgUp/← 上一页、Home/End 首末页。
      以视图激活态门控；输入框内按键（Home/End/箭头是编辑键）不劫持；
      Ctrl/⌘/Alt 组归宿主（Ctrl+PgDn/PgUp=上一/下一个文件）；Space/+/-/1-9/Esc 归宿主不碰 */
  private onKey = (e: KeyboardEvent): void => {
    if (!this.active) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "PageDown":
      case "ArrowRight":
        e.preventDefault();
        this.gotoPage(this.currentPage() + 1);
        break;
      case "PageUp":
      case "ArrowLeft":
        e.preventDefault();
        this.gotoPage(this.currentPage() - 1);
        break;
      case "Home":
        e.preventDefault();
        this.gotoPage(1);
        break;
      case "End":
        e.preventDefault();
        this.gotoPage(this.pdf?.numPages ?? 1);
        break;
    }
  };

  /** 缩放文案：适宽 / 百分比（状态栏模式与工具栏标签共用） */
  private zoomText(): string {
    return this.zoomMode === "fit" ? "适宽" : `${Math.round(this.zoom * 100)}%`;
  }

  /** 当前页码：占位几何判定（视口中线落在哪页），不等渲染完成 */
  private currentPage(): number {
    const n = this.pages.length;
    if (!n) return 1;
    return Math.min(n, this.pageAt(this.scroll.scrollTop + this.scroll.clientHeight / 2) + 1);
  }

  private syncStatus(): void {
    const cur = this.currentPage();
    this.ctx.setStatus({
      title: this.ctx.name,
      file: this.ctx.name,
      encoding: this.version ? `PDF ${this.version}` : "PDF",
      position: `第 ${cur}/${this.pdf?.numPages ?? "?"} 页`,
      mode: `模式: ${this.zoomText()}`,
      display: this.ctx.autoscroll.isScrolling() ? "滚屏中" : "-",
    });
    // 工具栏随动：页码输入（输入中不覆写）、总页数、缩放标签
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(cur);
    this.pageTotal.textContent = `/ ${this.pdf?.numPages ?? "?"}`;
    this.zoomLabel.textContent = this.zoomText();
  }

  setActive(on: boolean): void {
    this.active = on;
    if (on) this.syncStatus(); // 转前台恢复状态栏（后台期间被其他视图覆写）
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
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.resizeOb?.disconnect();
    this.resizeOb = null;
    this.hostEl?.removeEventListener("keydown", this.onKey);
    this.hostEl = null;
    this.ctx.autoscroll.detach();
    this.queue = [];
    for (const [, c] of this.canvases) {
      c.task?.cancel();
      c.el.remove();
    }
    this.canvases.clear();
    this.states = new Uint8Array(0);
    this.renderGen = [];
    this.pages = [];
    this.tops = [];
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
  version: "0.3.0",
  description: "PDF 阅读：pdf.js 连续滚屏渲染、适宽显示、页码跳转与翻页键、缩放（+/−/适宽/100%/Ctrl 滚轮），速度键与 Space 经宿主滚屏引擎可用",
  extensions: [".pdf"],
  open: (ctx) => view.open(ctx),
  togglePlay: () => view.togglePlay(),
  isPlaying: () => view.isPlaying(),
  deactivate: () => view.deactivate(),
};

export default plugin;
