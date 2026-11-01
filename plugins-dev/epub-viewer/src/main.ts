/* EPUB 查看插件：逐章渲染（跟随主题 / 书籍样式 Shadow DOM 双模式）、目录跳章、
   上一章/下一章（navFile）、按书路径记忆进度。自包含单文件 ESM。 */
import type { MenuItemDef } from "../../../src/dropdown";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import { decodeXml } from "../../_shared/decode";
import { baseOf } from "../../_shared/paths";
import { sanitizeTree } from "../../_shared/sanitize";
import { readTheme, watchTheme } from "../../_shared/theme";
import { parseZip, type MiniZip } from "./minizip";
import { parseEpub, type EpubBook } from "./opf";

const PID = "epub-viewer";
const POS_LIMIT = 200; // 进度记忆条数上限（LRU）

let prefMode: "theme" | "book" = "theme";
const openViews = new Set<EpubView>();

// 常量命名避开全局 CSS 命名空间（否则下方 CSS.escape 会解析到本字符串）
const VIEW_CSS = `
.hidden { display: none !important; }
.rbepub-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 7; display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-bottom: 1px solid var(--ui-border, #555); font-size: 13px; height: 30px; box-sizing: border-box; }
.rbepub-bar button { border: 1px solid var(--ui-border, #555); background: var(--ui-bg, #2b2b2b); color: inherit; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.rbepub-bar button:hover { background: var(--ui-hover, #3d3d3d); }
.rbepub-bar button:disabled { opacity: 0.4; cursor: default; }
.rbepub-title { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rbepub-scroll { position: absolute; inset: 30px 0 0 0; overflow: auto; outline: none; }
.rbepub-content { max-width: 760px; margin: 0 auto; padding: 24px 24px 48px; }
.rbepub-content p { margin: 0 0 0.75em; text-align: justify; }
.rbepub-content img { max-width: 100%; height: auto; }
.rbepub-content a { color: var(--accent, #4a9eff); }
.rbepub-toc { position: absolute; top: 30px; left: 0; bottom: 0; width: 240px; z-index: 6; overflow: auto; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-right: 1px solid var(--ui-border, #555); padding: 8px 0; }
.rbepub-toc.hidden { display: none; }
.rbepub-toc-row { display: block; width: 100%; text-align: left; background: none; border: none; color: inherit; font-size: 13px; padding: 5px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rbepub-toc-row:hover { background: var(--ui-hover, #3d3d3d); }
.rbepub-toc-row.active { color: var(--accent, #4a9eff); }
.rbepub-empty { padding: 40px; text-align: center; opacity: 0.6; }
`;

interface SavedPos {
  i: number;
  r: number; // 章内滚动比 0..1
  t: number; // 时间戳（LRU 淘汰用）
}

class EpubView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private zip!: MiniZip;
  private book!: EpubBook;
  private spineIdx = 0;
  private mode: "theme" | "book" = "theme";
  private scroll!: HTMLElement;
  private mount!: HTMLElement;
  private tocPanel!: HTMLElement;
  private titleEl!: HTMLElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private blobUrls: string[] = [];
  private lru = new Map<string, Uint8Array>();
  private unwatch: (() => void) | null = null;
  private saveTimer = 0;
  private locateTimer = 0; // 30ms 定位定时器（导航后立即 deactivate 时一并取消，防错配落进度）
  active = true; // 公开：noUnusedLocals 拒收只写私有字段（同 image-viewer 约定）
  private chapterTitle = "";
  private shadow: ShadowRoot | null = null;
  private restoreRatio: number | null = null;
  private ready = false; // 首章挂载完成前不落进度（防覆盖存档）

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.mode = prefMode = ctx.getSetting<"theme" | "book">("styleMode", "theme"); // 同步模块级勾选状态
    try {
      this.zip = parseZip(ctx.bytes);
      this.book = parseEpub(this.zip);
    } catch (e) {
      ctx.toast(`EPUB 解析失败：${e}`);
      ctx.closeView();
      return;
    }
    this.buildDom();
    this.unwatch = watchTheme(() => this.applyTheme());
    const rec = this.readPos();
    const startIdx = rec && rec.i < this.book.spine.length ? rec.i : 0;
    this.restoreRatio = rec ? rec.r : 0;
    if (rec && (startIdx > 0 || rec.r > 0.02)) ctx.toast("已续读上次位置");
    await this.renderSpine(startIdx);
    openViews.add(this);
  }

  private buildDom(): void {
    const host = this.ctx.host;
    const style = document.createElement("style");
    style.textContent = VIEW_CSS;
    const bar = document.createElement("div");
    bar.className = "rbepub-bar plugin-topbar";
    const btnToc = document.createElement("button");
    btnToc.textContent = "☰ 目录";
    btnToc.addEventListener("click", () => this.tocPanel.classList.toggle("hidden"));
    this.prevBtn = document.createElement("button");
    this.prevBtn.textContent = "‹ 上一章";
    this.prevBtn.addEventListener("click", () => void this.navFile(-1));
    this.nextBtn = document.createElement("button");
    this.nextBtn.textContent = "下一章 ›";
    this.nextBtn.addEventListener("click", () => void this.navFile(1));
    this.titleEl = document.createElement("span");
    this.titleEl.className = "rbepub-title";
    bar.append(btnToc, this.prevBtn, this.titleEl, this.nextBtn);

    this.tocPanel = document.createElement("div");
    this.tocPanel.className = "rbepub-toc hidden";
    for (const t of this.book.toc) {
      const row = document.createElement("button");
      row.className = "rbepub-toc-row";
      row.style.paddingLeft = `${8 + t.depth * 14}px`;
      row.textContent = t.label;
      row.addEventListener("click", () => {
        const idx = this.book.spine.indexOf(t.href);
        if (idx < 0) {
          this.ctx.toast("目录指向的内容不在书内");
          return;
        }
        this.tocPanel.classList.add("hidden");
        this.restoreRatio = 0; // 目录跳转从章首开始
        void this.renderSpine(idx, t.anchor);
      });
      this.tocPanel.appendChild(row);
    }

    this.scroll = document.createElement("div");
    this.scroll.className = "rbepub-scroll";
    this.scroll.tabIndex = 0;
    this.mount = document.createElement("div");
    this.mount.className = "rbepub-content";
    this.scroll.appendChild(this.mount);
    this.scroll.addEventListener("scroll", () => this.scheduleSave(), { passive: true });
    this.scroll.addEventListener("keydown", (e) => this.onKey(e));
    // 链接拦截：单次挂载在滚动容器上，composedPath 穿透 shadow root（书籍样式模式）
    this.scroll.addEventListener("click", (e) => this.onContentClick(e));
    host.append(style, bar, this.tocPanel, this.scroll);
  }

  /** 渲染第 i 章（anchor 定位优先，其次 restoreRatio 恢复） */
  private async renderSpine(i: number, anchor = ""): Promise<void> {
    this.saveProgress(); // 切章前保存旧章滚动比（ready=false 时自动跳过）
    this.spineIdx = i;
    const href = this.book.spine[i];
    this.chapterTitle = this.tocLabelFor(href) || baseOf(href);
    const ratio = this.restoreRatio;
    this.restoreRatio = null;

    let text = "";
    try {
      text = this.readEntryText(href);
    } catch {
      /* 条目缺失：走下方解析失败兜底 */
    }
    const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
    const bodySrc = doc.querySelector("parsererror") ? null : doc.body;
    this.revokeBlobs();
    this.mount.textContent = ""; // 清空同时移除旧 shadow root
    this.shadow = null;
    if (!bodySrc) {
      this.mount.innerHTML = '<div class="rbepub-empty">本章内容解析失败</div>';
    } else {
      const frag = document.importNode(bodySrc, true);
      sanitizeTree(frag);
      await this.rewriteAssets(frag, href);
      this.interceptLinks(frag, href);
      if (this.mode === "theme") {
        this.mount.append(...frag.childNodes);
      } else {
        // 书籍样式模式：Shadow DOM 隔离，书内 CSS 原样注入。
        // shadow root 一旦挂上无法摘除（textContent 清不掉），故用一次性子元素承载，
        // 清空 mount 时旧宿主连同 shadow 一并丢弃；否则二次进入书籍模式 attachShadow 会抛错
        const hostEl = document.createElement("div");
        this.mount.appendChild(hostEl);
        this.shadow = hostEl.attachShadow({ mode: "open" });
        const st = document.createElement("style");
        st.textContent = this.book.cssText;
        const inner = document.createElement("div");
        inner.append(...frag.childNodes);
        this.shadow.append(st, inner);
      }
    }

    const anchorSel = anchor ? `#${CSS.escape(anchor)}` : "";
    this.locateTimer = window.setTimeout(() => {
      if (anchorSel) {
        const el =
          (this.mount.querySelector(anchorSel) as HTMLElement | null) ||
          (this.shadow?.querySelector(anchorSel) as HTMLElement | null);
        if (el) el.scrollIntoView({ block: "start" });
        else this.scroll.scrollTop = 0;
      } else if (ratio && ratio > 0) {
        const max = this.scroll.scrollHeight - this.scroll.clientHeight;
        if (max > 0) this.scroll.scrollTop = ratio * max;
      } else {
        this.scroll.scrollTop = 0;
      }
      this.syncStatus(); // 定位后才反映真实滚动比（否则恢复/锚点后显示陈旧百分比）
    }, 30);

    this.prevBtn.disabled = i === 0;
    this.nextBtn.disabled = i === this.book.spine.length - 1;
    this.titleEl.textContent = this.chapterTitle;
    [...this.tocPanel.children].forEach((row, k) =>
      (row as HTMLElement).classList.toggle("active", this.book.toc[k]?.href === href)
    );
    this.applyTheme();
    this.syncStatus();
    this.ready = true;
    void this.prefetch(i + 1);
  }

  /** 图片转 blob URL（svg image 同时写 href）；ParentNode：importNode(body) 实为 HTMLElement */
  private async rewriteAssets(frag: ParentNode, chapterHref: string): Promise<void> {
    const dir = chapterHref.includes("/") ? chapterHref.slice(0, chapterHref.lastIndexOf("/")) : "";
    for (const el of [...frag.querySelectorAll("img, image")]) {
      const raw = el.getAttribute("src") || el.getAttribute("xlink:href") || el.getAttribute("href") || "";
      if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
      const target = resolveZip(dir, raw);
      try {
        const bytes = this.readEntry(target);
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeOf(target) }));
        this.blobUrls.push(url);
        el.setAttribute("src", url);
        el.setAttribute("href", url); // svg <image> 走 href
      } catch {
        el.remove();
      }
    }
  }

  /** 链接改写为 data 标记（点击统一由 onContentClick 处理） */
  private interceptLinks(frag: ParentNode, chapterHref: string): void {
    const dir = chapterHref.includes("/") ? chapterHref.slice(0, chapterHref.lastIndexOf("/")) : "";
    for (const a of [...frag.querySelectorAll<HTMLAnchorElement>("a[href]")]) {
      const raw = a.getAttribute("href") || "";
      if (/^(https?:|data:|mailto:)/i.test(raw)) continue;
      const si = raw.indexOf("#");
      const anchor = si >= 0 ? raw.slice(si + 1) : "";
      // si===0（纯 #锚点）与空 href 都视作本章内（resolveZip(dir,"") 会误返回 dir）；
      // si<0 为无锚点整链，仍走 resolveZip
      let pathPart: string;
      if (si > 0) pathPart = resolveZip(dir, raw.slice(0, si));
      else if (si === 0 || !raw) pathPart = chapterHref;
      else pathPart = resolveZip(dir, raw);
      if (pathPart === chapterHref) a.dataset.rbAnchor = anchor;
      else a.dataset.rbJump = `${pathPart}#${anchor}`;
      a.setAttribute("href", "#");
    }
  }

  /** 点击分派：同章锚点滚动 / 跨章跳转（composedPath 穿透 shadow） */
  private onContentClick(e: Event): void {
    const path = e.composedPath() as EventTarget[];
    const target = path[0] as HTMLElement | undefined;
    const a = target?.closest?.("a") as HTMLAnchorElement | null;
    if (!a) return;
    if (a.dataset.rbAnchor !== undefined) {
      e.preventDefault();
      this.scrollToAnchor(a.dataset.rbAnchor);
    } else if (a.dataset.rbJump !== undefined) {
      e.preventDefault();
      const si = a.dataset.rbJump.indexOf("#");
      const p = si >= 0 ? a.dataset.rbJump.slice(0, si) : a.dataset.rbJump;
      const anchor = si >= 0 ? a.dataset.rbJump.slice(si + 1) : "";
      const idx = this.book.spine.indexOf(p);
      if (idx < 0) this.ctx.toast("链接指向的内容不在书内");
      else {
        this.restoreRatio = 0;
        void this.renderSpine(idx, anchor);
      }
    }
  }

  private scrollToAnchor(anchor: string): void {
    if (!anchor) {
      this.scroll.scrollTop = 0;
      return;
    }
    const sel = `#${CSS.escape(anchor)}`;
    const el =
      (this.mount.querySelector(sel) as HTMLElement | null) ||
      (this.shadow?.querySelector(sel) as HTMLElement | null);
    if (el) el.scrollIntoView({ block: "start" });
    else this.scroll.scrollTop = 0;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      this.scroll.scrollBy(0, (e.key === "PageDown" ? 1 : -1) * this.scroll.clientHeight * 0.9);
    } else if (e.key === "ArrowRight") {
      void this.navFile(1);
    } else if (e.key === "ArrowLeft") {
      void this.navFile(-1);
    }
  }

  async navFile(delta: number): Promise<void> {
    const ni = this.spineIdx + delta;
    if (ni < 0 || ni >= this.book.spine.length) {
      this.ctx.toast(delta < 0 ? "已是第一章" : "已是最后一章");
      return;
    }
    await this.renderSpine(ni);
  }

  /* ========== 进度记忆 ========== */

  private posMap(): Record<string, SavedPos> {
    try {
      const v = JSON.parse(this.ctx.getSetting("positions", "{}")) as Record<string, SavedPos>;
      return v && typeof v === "object" ? v : {}; // "null" 等 JSON 合法但非对象的输入兜底
    } catch {
      return {};
    }
  }

  private readPos(): SavedPos | null {
    return this.posMap()[this.ctx.path] || null;
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveProgress(), 2000);
  }

  private saveProgress(): void {
    if (!this.ready) return; // 首章挂载完成前不写（防覆盖待恢复的存档）
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const r = max > 0 ? Math.min(1, this.scroll.scrollTop / max) : 0;
    const map = this.posMap();
    map[this.ctx.path] = { i: this.spineIdx, r, t: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > POS_LIMIT) {
      keys.sort((a, b) => map[a].t - map[b].t);
      for (const k of keys.slice(0, keys.length - POS_LIMIT)) delete map[k];
    }
    this.ctx.setSetting("positions", JSON.stringify(map));
  }

  /** 清除本书进度（公开：插件菜单模块层回调触达实例） */
  clearProgress(): void {
    const map = this.posMap();
    delete map[this.ctx.path];
    this.ctx.setSetting("positions", JSON.stringify(map));
    this.ready = false; // 抑制此后（含 deactivate）的保存，防清除被立刻写回
    this.ctx.toast("已清除本书进度");
  }

  /* ========== 渲染模式 / 主题 / 状态 ========== */

  /** 切换渲染模式（公开：插件菜单模块层回调触达实例）；保持当前滚动比 */
  setMode(mode: "theme" | "book"): void {
    this.mode = prefMode = mode;
    this.ctx.setSetting("styleMode", mode);
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    this.restoreRatio = max > 0 ? this.scroll.scrollTop / max : 0;
    void this.renderSpine(this.spineIdx);
  }

  private applyTheme(): void {
    if (this.mode !== "theme") return;
    const t = readTheme();
    this.scroll.style.background = t.bg;
    this.mount.style.color = t.text;
    this.mount.style.fontFamily = t.fontFamily;
    this.mount.style.fontSize = t.fontSize;
    this.mount.style.lineHeight = t.lineHeight;
  }

  private tocLabelFor(href: string): string {
    return this.book.toc.find((t) => t.href === href)?.label || "";
  }

  private syncStatus(): void {
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const pct = max > 0 ? Math.min(100, Math.round((this.scroll.scrollTop / max) * 100)) : 100;
    this.ctx.setStatus({
      title: this.ctx.name,
      file: this.chapterTitle,
      position: `第 ${this.spineIdx + 1}/${this.book.spine.length} 章 · ${pct}%`,
      encoding: `EPUB ${this.book.version}`,
      mode: `模式: ${this.mode === "theme" ? "跟随主题" : "书籍样式"}`,
      display: "-",
    });
  }

  /* ========== 条目读取（LRU 缓存 + 预取） ========== */

  private readEntry(name: string): Uint8Array {
    const hit = this.lru.get(name);
    if (hit) {
      this.lru.delete(name);
      this.lru.set(name, hit);
      return hit;
    }
    const bytes = this.zip.read(name);
    this.lru.set(name, bytes);
    if (this.lru.size > 32) this.lru.delete(this.lru.keys().next().value as string);
    return bytes;
  }

  private readEntryText(name: string): string {
    const hit = this.lru.get(name);
    if (hit) {
      this.lru.delete(name);
      this.lru.set(name, hit); // 刷新 LRU 新近度（与 readEntry 一致）
      return decodeXml(hit);
    }
    const bytes = this.zip.read(name);
    this.lru.set(name, bytes);
    if (this.lru.size > 32) this.lru.delete(this.lru.keys().next().value as string);
    return decodeXml(bytes);
  }

  private prefetch(i: number): void {
    if (i >= this.book.spine.length || this.lru.has(this.book.spine[i])) return;
    try {
      this.readEntry(this.book.spine[i]);
    } catch {
      /* 预取失败不阻塞 */
    }
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  deactivate(): void {
    this.saveProgress();
    openViews.delete(this);
    this.unwatch?.();
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.locateTimer);
    this.revokeBlobs();
  }

  private revokeBlobs(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
  }
}

/** zip 内相对路径解析（无复合前缀，段式） */
function resolveZip(dir: string, rel: string): string {
  let r = rel;
  try {
    r = decodeURIComponent(rel);
  } catch {
    /* 保持原样 */
  }
  const segs = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of r.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

function mimeOf(path: string): string {
  const e = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  if (e === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

const plugin: Read4EverPlugin = {
  id: PID,
  name: "EPUB 查看",
  version: "1.0.0",
  description: "EPUB 阅读：目录导航、进度记忆、跟随主题/书籍样式双模式",
  extensions: [".epub"],
  createView: () => new EpubView(),
  open: (ctx) => new EpubView().open(ctx), // 仅作 loader 校验占位（宿主在 createView 存在时不会调用）
  menu: (): MenuItemDef[] => [
    {
      label: "跟随阅读主题",
      checked: () => prefMode === "theme",
      action: () => openViews.forEach((v) => v.setMode("theme")),
    },
    {
      label: "书籍自带样式",
      checked: () => prefMode === "book",
      action: () => openViews.forEach((v) => v.setMode("book")),
    },
    { sep: true },
    { label: "清除本书进度", action: () => openViews.forEach((v) => v.clearProgress()) },
  ],
};

export default plugin;
