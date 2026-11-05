/* PDF 阅读插件：pdf.js 渲染 PDF 注入插件视图宿主（原样渲染，不跟随主题）。
   worker 以 blob 方式内联自启动（不依赖宿主 vite 配置），自包含单文件 ESM。
   数据路径在 acquireTask 分叉：声明 wantsStream 且宿主给得出流式 URL（Tauri 本地文件、
   本地 zip 存储型条目、SMB 普通文件）走 read4ever-stream:// Range 流式，大文件不整读内存；
   探针失败（本地 zip 压缩条目等）经 ctx.loadBytes 回退整读；浏览器 mock 与 SMB zip 条目
   宿主直接给整读 bytes。整读超限由大小防线挡下（256MB 自限 / 超 1GB 提示先缓存到本地）。 */
import "./shims"; // 必须最先 import：垫片先于 pdfjs-dist 模块体求值
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import { ensureWorker } from "./worker";
import { fullReadSizeError } from "./stream";
import { startStreamed } from "./transport";

const PID = "pdf";

/** 渲染任务的结构化最小类型（页.render 返回对象即可赋值） */
interface RenderTaskLike {
  cancel(): void;
  promise: Promise<void>;
}

/** 加载任务的结构化最小类型（onPassword 为 pdf.js 6.x 任务属性，赋值即可挂回调） */
interface LoadTaskLike {
  promise: Promise<PDFDocumentProxy>;
  destroy(): Promise<void>;
  onPassword: Function; // 与 pdfjs-dist d.ts 同宽：本插件只赋值不调用
}

const VIEW_CSS = `
.rbpdf-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 7; display: flex; align-items: center; gap: 8px; padding: 4px 10px; height: 30px; box-sizing: border-box; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-bottom: 1px solid var(--ui-border, #555); font-size: 13px; }
.rbpdf-title { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rbpdf-scroll { position: absolute; inset: 30px 0 0 0; overflow: auto; outline: none; background: var(--panel-bg, #1e1e1e); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 0; }
.rbpdf-page { position: relative; flex: none; overflow: hidden; background: #d9d9d9; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45); }
.rbpdf-page canvas { display: block; background: #fff; }
.rbpdf-pass { position: absolute; inset: 0; z-index: 9; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); }
.rbpdf-pass-card { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; min-width: 260px; background: var(--ui-bg, #2b2b2b); color: var(--ui-text, #e0e0e0); border: 1px solid var(--ui-border, #555); border-radius: 6px; font-size: 13px; }
.rbpdf-pass-input { box-sizing: border-box; width: 100%; padding: 5px 8px; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border: 1px solid var(--ui-border, #555); border-radius: 4px; font-size: 13px; }
.rbpdf-pass-hint { min-height: 1.2em; color: #e07b7b; font-size: 12px; }
.rbpdf-pass-ok { padding: 4px 14px; background: var(--accent, #4a9eff); color: #fff; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; }
.rbpdf-pass-cancel { padding: 4px 14px; background: transparent; color: var(--ui-text, #e0e0e0); border: 1px solid var(--ui-border, #555); border-radius: 4px; font-size: 13px; cursor: pointer; }
.rbpdf-pass-btns { display: flex; justify-content: flex-end; gap: 8px; }
`;

class PdfView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private pdf: PDFDocumentProxy | null = null;
  private loadTask: LoadTaskLike | null = null; // v6 起销毁走加载任务
  private streamed = false; // 本次加载走流式 Range 传输（状态栏标注 + 流式验证证据）
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
  private destroyed = false; // 视图已销毁：迟到的解析失败/密码回调静默收场
  private passEl: HTMLDivElement | null = null; // 加密 PDF 自建密码框（宿主无输入类对话框）
  private passInput: HTMLInputElement | null = null;
  private passHint: HTMLSpanElement | null = null;
  private passUpdate: ((password: string) => void) | null = null;
  active = true; // 公开：noUnusedLocals 拒收只写私有字段（同 EPUB 约定）

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.active = true;
    this.destroyed = false;
    ctx.setStatus({
      title: ctx.name,
      file: ctx.name,
      encoding: "PDF",
      position: "解析中…",
      mode: "模式: 适宽",
      display: "-",
    });
    ensureWorker();
    this.buildDom();
    // 滚屏引擎挂到滚动容器：速度键/Space 经宿主 togglePlayback 递入；到末尾引擎自停并回调
    this.ctx.autoscroll.attach(this.scroll, {
      onEnd: () => {
        this.ctx.toast("已读到末尾");
        this.syncStatus();
      },
    });
    // 后台解析不阻塞 open：密码输入/报错期间宿主已可见可交互
    //（open 返回前宿主 .hidden 未摘，阻塞等输入会死锁）
    void this.loadDocument();
  }

  private async loadDocument(): Promise<void> {
    // 数据路径分叉：流式 / 整读在此选定加载任务，密码与错误链路对两条路径同一份
    const task = await this.acquireTask();
    if (!task) return; // 整读超限已报错收场（或视图已销毁）
    try {
      // 密码回调挂加载任务上（pdf.js 6.x：PasswordRequest 异步到达，此刻赋值无竞态）；
      // code=INCORRECT_PASSWORD 时提示重试
      task.onPassword = (update: (password: string) => void, code: number): void =>
        this.showPassword(update, code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      this.loadTask = task;
      this.pdf = await task.promise;
    } catch (e) {
      this.pdf = null;
      if (this.destroyed) return; // 取消密码/视图已关：静默收场，不报错误 toast
      // 无效数据/解析失败：明确中文报错后收场，应用可继续打开其他文件
      this.ctx.toast(
        e instanceof pdfjsLib.InvalidPDFException
          ? "无法打开：文件已损坏或不是 PDF 文档"
          : `PDF 打开失败：${String(e).slice(0, 80)}`
      );
      this.ctx.closeView();
      return;
    }
    if (this.destroyed) return;
    this.hidePassword();
    const meta = await this.pdf.getMetadata();
    if (this.destroyed) return;
    this.version = (meta.info as { PDFFormatVersion?: string }).PDFFormatVersion || "";
    await this.buildPages();
    this.update();
  }

  /** 数据路径分叉点：有流式 URL（Tauri 本地文件、本地 zip 存储型条目、SMB 普通文件）先试
      Range 流式；探针失败（本地 zip 压缩条目 404 等）经 ctx.loadBytes 回退整读——
      wantsStream 命中时宿主跳过预读（ctx.bytes 恒空），整读一律现读。其余场景（浏览器
      mock、SMB zip 条目）宿主已给整读 bytes，直接走大小防线 */
  private async acquireTask(): Promise<LoadTaskLike | null> {
    this.streamed = false;
    const url = this.ctx.streamUrlFor?.(this.ctx.path);
    if (typeof url === "string") {
      try {
        const { task } = await startStreamed(url);
        this.streamed = true;
        return task;
      } catch {
        if (this.destroyed) return null; // 探针期间视图已关：静默收场
        // 流式不可用：按字节整读回退（video-viewer 同款），超限防线在整读侧统一挡
      }
    }
    return this.newFullReadTask();
  }

  /** 整读路径：bytes 交给 pdf.js；超限按大小防线明确报错收场 */
  private async newFullReadTask(): Promise<LoadTaskLike | null> {
    let bytes = this.ctx.bytes;
    if (!bytes.length) {
      try {
        bytes = await this.ctx.loadBytes(this.ctx.path);
      } catch {
        if (!this.destroyed) this.ctx.toast("无法读取文件内容");
        return null;
      }
    }
    const err = fullReadSizeError(bytes.length);
    if (err) {
      if (!this.destroyed) {
        this.ctx.toast(err);
        this.ctx.closeView();
      }
      return null;
    }
    // data 会转移 TypedArray 所有权，传副本保住原始引用
    return pdfjsLib.getDocument({ data: bytes.slice() });
  }

  private cleanupLoadTask(): void {
    void this.loadTask?.destroy();
    this.loadTask = null;
    this.pdf = null;
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
    this.scroll.addEventListener("scroll", this.onScroll, { passive: true });
    host.append(style, bar, this.scroll);
    this.resizeOb = new ResizeObserver(this.onResize);
    this.resizeOb.observe(this.scroll);
  }

  /** 加密 PDF 密码输入（复用同一浮层：错误密码时 pdf.js 会再次回调，不叠框） */
  private showPassword(update: (password: string) => void, incorrect = false): void {
    if (this.destroyed) return;
    this.passUpdate = update;
    if (!this.passEl) {
      const el = document.createElement("div");
      el.className = "rbpdf-pass";
      const card = document.createElement("div");
      card.className = "rbpdf-pass-card";
      const label = document.createElement("span");
      label.textContent = "PDF 已加密";
      const hint = document.createElement("span");
      hint.className = "rbpdf-pass-hint";
      const input = document.createElement("input");
      input.type = "password";
      input.className = "rbpdf-pass-input";
      input.placeholder = "密码";
      const ok = document.createElement("button");
      ok.className = "rbpdf-pass-ok";
      ok.textContent = "确定";
      ok.addEventListener("click", () => this.passUpdate?.(input.value));
      const cancel = document.createElement("button");
      cancel.className = "rbpdf-pass-cancel";
      cancel.textContent = "取消";
      // 取消等同 Esc 关闭路径：销毁加载任务并收场（deactivate 置 destroyed，迟到异常静默）
      cancel.addEventListener("click", () => {
        this.hidePassword();
        this.ctx.closeView();
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") this.passUpdate?.(input.value);
      });
      const btns = document.createElement("div");
      btns.className = "rbpdf-pass-btns";
      btns.append(cancel, ok);
      card.append(label, hint, input, btns);
      el.appendChild(card);
      this.passEl = el;
      this.passInput = input;
      this.passHint = hint;
      this.ctx.host.appendChild(el);
    }
    this.passHint!.textContent = incorrect ? "密码不正确，请重试" : "";
    this.passEl.classList.remove("hidden");
    this.passInput!.value = "";
    this.passInput!.focus();
  }

  private hidePassword(): void {
    this.passUpdate = null;
    this.passEl?.remove();
    this.passEl = null;
    this.passInput = null;
    this.passHint = null;
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

  /** 按当前适宽重排占位尺寸与 tops 前缀（打开与窗口变化时调用）。
      滚动容器为 flex 纵列 + gap 12 + 上下 padding 12：页间距不塌陷，tops 与 DOM 布局严格一致 */
  private layout(): void {
    this.cssW = Math.max(120, this.scroll.clientWidth - 24); // 页左右留 12px×2
    this.tops = [];
    let y = 12;
    for (let i = 0; i < this.pages.length; i++) {
      const d = this.pageDims[i];
      const h = Math.round((d.h * this.cssW) / d.w);
      this.pages[i].style.width = `${this.cssW}px`;
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
      const scale = this.cssW / d.w;
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

  private async refit(): Promise<void> {
    if (!this.pdf || !this.active) return;
    if (this.scroll.clientWidth < 60) return; // 宿主尚隐藏（display:none）：无意义布局不渲染
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const ratio = max > 0 ? this.scroll.scrollTop / max : 0;
    this.queue = [];
    for (const [i, c] of [...this.canvases]) {
      c.task?.cancel();
      c.el.remove();
      this.canvases.delete(i);
      this.renderGen[i] = -1;
    }
    this.states = new Uint8Array(this.pages.length);
    this.layout();
    const nm = this.scroll.scrollHeight - this.scroll.clientHeight;
    if (nm > 0) this.scroll.scrollTop = ratio * nm;
    this.update();
  }

  /** 当前页码：占位几何判定（视口中线落在哪页），不等渲染完成 */
  private currentPage(): number {
    const n = this.pages.length;
    if (!n) return 1;
    return Math.min(n, this.pageAt(this.scroll.scrollTop + this.scroll.clientHeight / 2) + 1);
  }

  private syncStatus(): void {
    this.ctx.setStatus({
      title: this.ctx.name,
      file: this.ctx.name,
      encoding: (this.version ? `PDF ${this.version}` : "PDF") + (this.streamed ? " 流式" : ""),
      position: `第 ${this.currentPage()}/${this.pdf?.numPages ?? "?"} 页`,
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
    this.destroyed = true;
    this.hidePassword();
    window.clearTimeout(this.resizeTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.resizeOb?.disconnect();
    this.resizeOb = null;
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
  description:
    "PDF 阅读：pdf.js 连续滚屏渲染、适宽显示，速度键与 Space 经宿主滚屏引擎可用；大文件走宿主流式协议 Range 分块加载（探针失败自动回退整读，256MB/1GB 分级防线）",
  extensions: [".pdf"],
  wantsStream: true,
  open: (ctx) => view.open(ctx),
  togglePlay: () => view.togglePlay(),
  isPlaying: () => view.isPlaying(),
  deactivate: () => view.deactivate(),
};

export default plugin;
