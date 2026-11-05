/* PDF 阅读插件：pdf.js 渲染 PDF 注入插件视图宿主（原样渲染，不跟随主题）。
   worker 以 blob 方式内联自启动（不依赖宿主 vite 配置），自包含单文件 ESM。 */
import "./shims"; // 必须最先 import：垫片先于 pdfjs-dist 模块体求值
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import workerText from "../dist/pdf.worker.min.mjs.txt";
import { parsePosMap, upsertPos, POS_DEBOUNCE_MS, type PdfSavedPos } from "./positions";

/* 进度存档的纯逻辑具名导出：测试缝（playwright import dist 实例验证 LRU 淘汰序），
   不影响插件包语义（loader 只取 default）；实现于 ./positions */
export { parsePosMap, upsertPos, POS_LIMIT, POS_DEBOUNCE_MS } from "./positions";
export type { PdfSavedPos, PosMap } from "./positions";

const PID = "pdf";

let workerUrl = ""; // 模块级复用：worker 从 blob 实例化后 URL 即无存在必要，保留给后续打开复用

/* pdf.js 6.5 直接依赖 2025 年新入库的 ES 方法（Map upsert、Uint8Array 二进制扩展、
   Promise.withResolvers、Set.intersection、Math.sumPrecise——加密解密路径必经）且不带垫片，
   旧内核没有会整体解析失败——以 prologue 前置进 worker blob 补齐（与 src/shims.ts 同一组垫片，
   保持同步）。 */
const WORKER_PROLOGUE = `
function rbUpsert(p){Object.assign(p,{getOrInsert:function(k,v){if(!this.has(k))this.set(k,v);return this.get(k)},getOrInsertComputed:function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)}})}
if(!Map.prototype.getOrInsert)rbUpsert(Map.prototype);
if(!WeakMap.prototype.getOrInsert)rbUpsert(WeakMap.prototype);
if(!Uint8Array.prototype.toHex){Uint8Array.prototype.toHex=function(){let s='';for(const b of this)s+=b.toString(16).padStart(2,'0');return s}}
if(!Uint8Array.prototype.toBase64){Uint8Array.prototype.toBase64=function(){let s='';for(let i=0;i<this.length;i+=32768)s+=String.fromCharCode.apply(null,this.subarray(i,i+32768));return btoa(s)}}
if(!Uint8Array.fromBase64){Uint8Array.fromBase64=function(s){const b=atob(String(s).replace(/\\s+/g,''));const o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o}}
if(!Set.prototype.intersection){Set.prototype.intersection=function(o){const t=this.size<=o.size?this:o,b=t===this?o:this,n=new Set();for(const v of t)if(b.has(v))n.add(v);return n}}
if(!Promise.withResolvers){Promise.withResolvers=function(){let r,j;const p=new Promise(function(a,b){r=a;j=b});return{promise:p,resolve:r,reject:j}}}
if(!Math.sumPrecise){Math.sumPrecise=function(v){let s=0;for(const x of v)s+=x;return s}}
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

/** 文本层任务的结构化最小类型（pdf.js TextLayer：render 完成铺 span、cancel 中止） */
interface TextLayerLike {
  render(): Promise<unknown>;
  cancel(): void;
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
/* 文本层（pdf.js TextLayer 容器）：以 scale=1 视口铺 span（百分比定位），再整体等比缩放
   --rb-scale 对齐 canvas——缩放时只改变量不重建，几何恒对齐。样式要点取自 pdf.js
   pdf_viewer.css 的 .textLayer：透明文字 + 绝对定位 + transform-origin 0 0 + 半透明选区 */
.rbpdf-text {
  position: absolute; top: 0; left: 0; z-index: 2;
  overflow: clip; line-height: 1; text-align: initial;
  letter-spacing: normal; word-spacing: normal;
  -webkit-text-size-adjust: none; text-size-adjust: none;
  forced-color-adjust: none; color-scheme: only light;
  transform-origin: 0 0;
  transform: scale(var(--rb-scale, 1));
  /* scale=1 视口的容器尺寸由 pdf.js setLayerDimensions 写入（total-scale-factor=1） */
  --total-scale-factor: 1;
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.rbpdf-text :is(span, br) {
  color: transparent; position: absolute; white-space: pre;
  cursor: text; transform-origin: 0 0; user-select: text;
  --font-height: 0; --scale-x: 1; --rotate: 0deg;
}
.rbpdf-text > :not(.markedContent),
.rbpdf-text .markedContent span:not(.markedContent) {
  z-index: 1;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.rbpdf-text .markedContent { display: contents; }
.rbpdf-text ::selection { background: rgba(0, 0, 255, 0.25); color: transparent; }
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
  private version = ""; // PDF 版本号（getMetadata 的 PDFFormatVersion）
  private scroll!: HTMLElement;
  private pageDims: { w: number; h: number }[] = []; // 每页 scale=1 视口尺寸（占位几何来源）
  private pages: HTMLDivElement[] = []; // 占位序列（固定尺寸，canvas 进出其中）
  private tops: number[] = []; // 占位顶部 y（含 12px 页边距），布局真值的 JS 副本免逐帧读 DOM
  private heights: number[] = []; // 每页占位高（布局真值 JS 副本：关视图时 DOM 已隐藏读不到）
  private cssW = 0; // 当前适宽页宽
  private states = new Uint8Array(0); // 每页渲染态：0 空 1 排队 2 渲染中 3 完成
  private renderGen: number[] = []; // 每页在途渲染令牌（回收/重排作废在途提交）
  private canvases = new Map<
    number,
    { el: HTMLCanvasElement; task: RenderTaskLike | null; textEl: HTMLDivElement | null; textTask: TextLayerLike | null }
  >();
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
  private ready = false; // 首次真实布局前不落进度（防打开即覆盖待恢复的存档，EPUB 同款门）
  private pendingRestore: { i: number; r: number } | null = null; // 待恢复存档（文档+真实布局就绪时消费）
  private lastSt = 0; // 最近滚动位置缓存（update 随动；关视图时宿主已隐藏、DOM scrollTop 读 0）
  private saveTimer = 0; // 进度落盘防抖定时器（滚动停止 2 秒后落一次，EPUB 同款）
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
    // 单例复用先清上次残留（防未消费的恢复存档串扰到无记录文件），再读本文件进度
    this.ready = false;
    this.pendingRestore = null;
    this.lastSt = 0;
    const rec = this.readPos();
    if (rec) this.pendingRestore = { i: rec.i, r: Math.min(1, Math.max(0, rec.r)) };
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
    try {
      // data 会转移 TypedArray 所有权，传副本保住 ctx.bytes
      const task = pdfjsLib.getDocument({ data: this.ctx.bytes.slice() });
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
    if (this.scroll.clientWidth >= 60) {
      // 宿主已可见：布局真值在位，恢复定位立即消费并解除落盘门
      this.consumePendingRestore();
      this.ready = true;
    }
    this.update();
  }

  /** 读本文件的进度存档（无/页索引非法返回 null） */
  private readPos(): PdfSavedPos | null {
    const rec = parsePosMap(this.ctx.getSetting("positions", "{}"))[this.ctx.path];
    return rec && rec.i >= 0 ? rec : null;
  }

  /** 应用待恢复存档：定位「页顶 + 页内比」。布局未就绪（页序列未建）不消费，等下一次时机 */
  private consumePendingRestore(): boolean {
    if (!this.pendingRestore || !this.pages.length) return false;
    const p = this.pendingRestore;
    this.pendingRestore = null;
    if (p.i >= this.pages.length) return false;
    const h = this.heights[p.i] ?? 0;
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    this.scroll.scrollTop = Math.max(0, Math.min(max, this.tops[p.i] + p.r * h));
    if (p.i > 0 || p.r > 0.02) this.ctx.toast("已续读上次位置");
    return true;
  }

  /** 落进度：存「页索引 + 页内滚动比」，经 ctx.setSetting 持久化（LRU 200 条见 positions.ts）。
      关视图时宿主已先被隐藏（closeView 先 hidden 再 deactivate），故位置/页高全取 JS 布局真值 */
  private saveProgress(): void {
    if (!this.ready || !this.pdf || !this.pages.length) return; // 首次真实布局前不写（防覆盖存档）
    const st = this.lastSt;
    const i = Math.min(this.pageAt(st), this.pages.length - 1);
    const h = this.heights[i] ?? 0;
    const r = h > 0 ? Math.min(1, Math.max(0, (st - this.tops[i]) / h)) : 0;
    const map = upsertPos(parsePosMap(this.ctx.getSetting("positions", "{}")), this.ctx.path, { i, r });
    this.ctx.setSetting("positions", JSON.stringify(map));
  }

  /** 滚动防抖落进度（2 秒）：连续滚动只留最后一次，停稳即存 */
  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.saveProgress();
    }, POS_DEBOUNCE_MS);
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
    this.heights = [];
    let y = 12;
    for (let i = 0; i < this.pages.length; i++) {
      const d = this.pageDims[i];
      const scale = this.cssW / d.w;
      const h = Math.round(d.h * scale);
      this.pages[i].style.width = `${this.cssW}px`;
      this.pages[i].style.height = `${h}px`;
      // 文本层等比缩放因子随缩放联动（文本层只读此变量，不需重建）
      this.pages[i].style.setProperty("--rb-scale", String(scale));
      this.tops.push(y);
      this.heights.push(h);
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
    this.lastSt = this.scroll.scrollTop; // 滚动位置缓存（关视图后 DOM 读不到，见 saveProgress）
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
    this.scheduleSave(); // 滚动即续期防抖：连续滚动不落盘，停 2 秒才落一次
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

  /** 回收第 i 页渲染层与文本层（占位保留高度），作废在途渲染令牌 */
  private reclaim(i: number): void {
    const c = this.canvases.get(i);
    this.renderGen[i] = -1;
    if (this.states[i] !== 0) this.states[i] = 0;
    if (!c) return;
    c.task?.cancel();
    c.el.remove();
    c.textTask?.cancel();
    c.textEl?.remove();
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
      this.canvases.set(i, { el: canvas, task, textEl: null, textTask: null });
      try {
        await task.promise;
      } catch (e) {
        if (e instanceof pdfjsLib.RenderingCancelledException) return; // 回收路径已清场
        throw e;
      }
      if (this.renderGen[i] === seq) {
        this.states[i] = 3;
        this.buildTextLayer(i, page);
      }
    } finally {
      this.pumping--;
      this.pump();
    }
  }

  /** 第 i 页叠文本层（canvas 完成后调用）：pdf.js TextLayer 以 scale=1 视口铺 span，
      几何随 --rb-scale 等比缩放；disableNormalization 保持摘录与源文一致。
      失败只损选择不影响画面，吞掉异常即可 */
  private buildTextLayer(i: number, page: PDFPageProxy): void {
    const slot = this.pages[i];
    const rec = this.canvases.get(i);
    if (!slot || !rec || rec.textEl) return;
    const el = document.createElement("div");
    el.className = "rbpdf-text";
    slot.append(el);
    let tl: TextLayerLike;
    try {
      tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent({ disableNormalization: true }),
        container: el,
        viewport: page.getViewport({ scale: 1 }),
      });
    } catch {
      el.remove();
      return;
    }
    rec.textEl = el;
    rec.textTask = tl;
    void tl.render().catch(() => { /* 回收取消（AbortException）或构建失败：画布仍是完整呈现 */ });
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
    for (const i of [...this.canvases.keys()]) this.reclaim(i); // 连文本层一并回收（缩放联动靠 --rb-scale，重建兜底）
    this.states = new Uint8Array(this.pages.length);
    this.layout();
    if (!this.consumePendingRestore()) {
      // 有待恢复存档时按「页+页内比」定位；否则保持整体滚动比换算（窗口缩放不丢位置）
      const nm = this.scroll.scrollHeight - this.scroll.clientHeight;
      if (nm > 0) this.scroll.scrollTop = ratio * nm;
    }
    this.update();
    this.ready = true; // 真实布局已就绪：此后才允许落进度
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
      encoding: this.version ? `PDF ${this.version}` : "PDF",
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
    this.saveProgress(); // 关视图即存（不等防抖）：「关闭再开恢复」的稳定落点
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
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
      c.textTask?.cancel();
      c.textEl?.remove();
    }
    this.canvases.clear();
    this.states = new Uint8Array(0);
    this.renderGen = [];
    this.pages = [];
    this.tops = [];
    this.heights = [];
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
