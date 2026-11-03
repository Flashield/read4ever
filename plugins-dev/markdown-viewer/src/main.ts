/* Markdown 查看插件：渲染 .md 为富文本阅读视图，跟随阅读主题。
   自包含单文件 ESM（marked 随包打入）；宿主能力全部经 PluginOpenContext 递入。 */
import { marked } from "marked";
import type { MenuItemDef } from "../../../src/dropdown";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import { decodeText } from "../../_shared/decode";
import { baseOf, dirOf, resolveUnder } from "../../_shared/paths";
import { sanitizeTree } from "../../_shared/sanitize";
import { readTheme, watchTheme } from "../../_shared/theme";

const PID = "markdown-viewer";

/** 模块级偏好与存活实例表（插件菜单 action 需要触达当前实例） */
let prefSource = false;
const openViews = new Set<MarkdownView>();

const CSS = `
.hidden { display: none !important; }
.rbmd-scroll { position: absolute; inset: 0; overflow: auto; outline: none; }
.rbmd-body { max-width: 760px; margin: 0 auto; padding: 28px 24px 48px; word-wrap: break-word; }
.rbmd-body h1, .rbmd-body h2, .rbmd-body h3, .rbmd-body h4, .rbmd-body h5, .rbmd-body h6 { line-height: 1.35; margin: 1.2em 0 0.5em; font-weight: 600; }
.rbmd-body h1 { font-size: 1.6em; } .rbmd-body h2 { font-size: 1.4em; } .rbmd-body h3 { font-size: 1.2em; }
.rbmd-body p { margin: 0 0 0.75em; text-align: justify; }
.rbmd-body blockquote { margin: 0.8em 0; padding: 0.2em 1em; border-left: 3px solid var(--accent, #4a9eff); opacity: 0.85; }
.rbmd-body pre { padding: 10px 12px; border-radius: 6px; background: rgba(128,128,128,.14); overflow: auto; font-size: 0.85em; line-height: 1.6; }
.rbmd-body code { font-family: Consolas, Menlo, monospace; font-size: 0.9em; }
.rbmd-body :not(pre) > code { padding: 1px 5px; border-radius: 4px; background: rgba(128,128,128,.14); }
.rbmd-body table { border-collapse: collapse; margin: 0.8em 0; font-size: 0.95em; }
.rbmd-body th, .rbmd-body td { border: 1px solid rgba(128,128,128,.45); padding: 4px 12px; }
.rbmd-body img { max-width: 100%; height: auto; }
.rbmd-body a { color: var(--accent, #4a9eff); }
.rbmd-body hr { border: none; border-top: 1px solid rgba(128,128,128,.4); margin: 1.4em 0; }
.rbmd-body input[type="checkbox"] { margin-right: 4px; }
.rbmd-src { margin: 0; padding: 20px 24px; font: 0.9em/1.7 Consolas, Menlo, monospace; white-space: pre-wrap; }
.rbmd-bar { position: absolute; top: 8px; left: 8px; z-index: 7; display: flex; gap: 6px; }
.rbmd-bar button { border: 1px solid var(--ui-border, #555); background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.rbmd-bar button:hover { background: var(--ui-hover, #3d3d3d); }
.rbmd-outline { position: absolute; top: 0; left: 0; bottom: 0; width: 220px; z-index: 6; overflow: auto; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-right: 1px solid var(--ui-border, #555); padding: 8px 0; }
.rbmd-outline.hidden { display: none; }
.rbmd-outline-row { display: block; width: 100%; text-align: left; background: none; border: none; color: inherit; font-size: 13px; padding: 5px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rbmd-outline-row:hover { background: var(--ui-hover, #3d3d3d); }
.rbmd-outline-row.active { color: var(--accent, #4a9eff); }
.rbmd-img-miss { opacity: 0.55; font-size: 0.85em; }
`;

class MarkdownView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private scroll!: HTMLElement;
  private body!: HTMLElement;
  private srcView!: HTMLElement;
  private outline!: HTMLElement;
  private outlineRows: HTMLElement[] = [];
  private headings: HTMLElement[] = [];
  private blobUrls: string[] = [];
  private unwatch: (() => void) | null = null;
  private text = "";
  private encLabel = "UTF-8";
  private asSource = false;
  /** 仅激活 tab 的实例响应全局事件（当前无 window 级监听）；公开字段备用（私有只写字段会触发 noUnusedLocals） */
  active = true;
  private idx = 0;
  private siblings: string[] = [];
  private path = "";
  private scrollTimer = 0;

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.path = ctx.path;
    this.siblings = ctx.siblings;
    this.idx = ctx.siblingIndex;
    this.asSource = prefSource = ctx.getSetting("viewSource", false);
    this.buildDom();
    ctx.autoscroll.attach(this.scroll); // 宿主滚屏引擎接管 this.scroll（togglePlay 即用）
    this.unwatch = watchTheme(() => this.applyTheme());
    const { text, label } = decodeText(ctx.bytes);
    this.text = text;
    this.encLabel = label;
    this.applyTheme();
    this.renderView();
    this.syncStatus();
    openViews.add(this);
  }

  private buildDom(): void {
    const host = this.ctx.host;
    const style = document.createElement("style");
    style.textContent = CSS;
    const bar = document.createElement("div");
    bar.className = "rbmd-bar plugin-topbar";
    const btnOutline = document.createElement("button");
    btnOutline.textContent = "☰ 大纲";
    btnOutline.addEventListener("click", () => this.toggleOutline());
    this.outline = document.createElement("div");
    this.outline.className = "rbmd-outline hidden";
    this.scroll = document.createElement("div");
    this.scroll.className = "rbmd-scroll";
    this.scroll.tabIndex = 0;
    this.body = document.createElement("div");
    this.body.className = "rbmd-body";
    this.srcView = document.createElement("pre");
    this.srcView.className = "rbmd-src hidden";
    this.scroll.append(this.body, this.srcView);
    bar.appendChild(btnOutline);
    host.append(style, bar, this.outline, this.scroll);
    this.scroll.addEventListener("scroll", () => this.onScroll(), { passive: true });
  }

  private applyTheme(): void {
    const t = readTheme();
    this.scroll.style.background = t.bg;
    this.body.style.color = t.text;
    this.body.style.fontFamily = t.fontFamily;
    this.body.style.fontSize = t.fontSize;
    this.body.style.lineHeight = t.lineHeight;
    this.srcView.style.color = t.text;
    this.srcView.style.background = t.bg;
  }

  private renderView(): void {
    window.clearTimeout(this.scrollTimer); // 重渲染前清掉残留的高亮定时器
    this.revokeBlobs();
    if (this.asSource) {
      this.body.classList.add("hidden");
      this.srcView.classList.remove("hidden");
      this.srcView.textContent = this.text || "(空文件)";
      this.outline.classList.add("hidden");
      this.outlineRows = [];
      return;
    }
    this.srcView.classList.add("hidden");
    this.body.classList.remove("hidden");
    if (!this.text.trim()) {
      this.body.innerHTML = "<p>（空文件）</p>";
    } else {
      const tpl = document.createElement("template");
      tpl.innerHTML = marked.parse(this.text, { async: false, gfm: true, breaks: false }) as string;
      sanitizeTree(tpl.content); // template 内容惰性（不抓图不执行），净化后再挂载
      this.body.replaceChildren(...tpl.content.childNodes);
    }
    this.buildOutline();
    void this.fixImages();
    this.scroll.scrollTop = 0;
    this.onScroll();
  }

  private buildOutline(): void {
    this.outline.innerHTML = "";
    this.outlineRows = [];
    this.headings = [];
    for (const h of this.body.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      const el = h as HTMLElement;
      el.id = el.id || `rbmd-h-${this.headings.length}`;
      this.headings.push(el);
      const row = document.createElement("button");
      row.className = "rbmd-outline-row";
      row.style.paddingLeft = `${8 + (Number(el.tagName[1]) - 1) * 14}px`;
      row.textContent = el.textContent || "(无标题)";
      row.addEventListener("click", () => el.scrollIntoView({ block: "start" }));
      this.outline.appendChild(row);
      this.outlineRows.push(row);
    }
  }

  /** 相对路径图片经 ctx.loadBytes 读同容器文件转 blob URL；越界/缺失替换为占位文字 */
  private async fixImages(): Promise<void> {
    const dir = dirOf(this.path);
    for (const img of [...this.body.querySelectorAll("img[src]")]) {
      const el = img as HTMLImageElement;
      const raw = el.getAttribute("src") || "";
      el.removeAttribute("srcset"); // DPR 变体会绕过重写的 src
      if (/^(https?:|data:|blob:)/i.test(raw)) continue; // 外链保持原样
      const target = resolveUnder(dir, raw);
      try {
        const bytes = await this.ctx.loadBytes(target);
        if (!el.isConnected) return; // 等待期间视图已重渲染/销毁：丢弃本次结果
        // 与内置 image-viewer 同款写法：TS6 的 BlobPart 只认 ArrayBuffer 视图，需显式收窄
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeOf(target) }));
        this.blobUrls.push(url);
        el.src = url;
      } catch {
        const span = document.createElement("span");
        span.className = "rbmd-img-miss";
        span.textContent = `🖼 未找到图片：${raw}`;
        el.replaceWith(span);
      }
    }
  }

  private toggleOutline(): void {
    if (this.asSource) {
      this.ctx.toast("源码模式下无大纲");
      return;
    }
    this.outline.classList.toggle("hidden");
    this.onScroll();
  }

  private onScroll(): void {
    if (this.asSource || this.outline.classList.contains("hidden")) return;
    window.clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => {
      let cur = -1;
      for (let i = 0; i < this.headings.length; i++) {
        if (this.headings[i].getBoundingClientRect().top <= 90) cur = i;
      }
      this.outlineRows.forEach((r, i) => r.classList.toggle("active", i === cur));
    }, 150);
  }

  /** 上一份/下一份：同容器 siblings 接续（宿主限定在当前目录/压缩包内） */
  async navFile(delta: number): Promise<void> {
    const ni = this.idx + delta;
    if (ni < 0 || ni >= this.siblings.length) {
      this.ctx.toast(delta < 0 ? "已是第一份" : "已是最后一份");
      return;
    }
    try {
      const bytes = await this.ctx.loadBytes(this.siblings[ni]);
      this.idx = ni;
      this.path = this.siblings[ni];
      this.ctx.path = this.path; // 宿主 activeFilePath() 跟随
      const { text, label } = decodeText(bytes);
      this.text = text;
      this.encLabel = label;
      this.renderView();
      this.syncStatus();
    } catch (e) {
      this.ctx.toast(`读取失败：${e}`);
    }
  }

  /** 渲染/源码切换（公开：插件菜单模块层回调触达实例） */
  setSource(on: boolean): void {
    this.asSource = prefSource = on;
    this.ctx.setSetting("viewSource", on);
    this.renderView();
    this.syncStatus();
  }

  /* 宿主滚屏能力（Space/滚屏按钮）：速度档、常亮、光标隐藏与显示格全由引擎接管 */
  togglePlay(): void {
    this.ctx.autoscroll.toggle();
  }

  isPlaying(): boolean {
    return this.ctx.autoscroll.isScrolling();
  }

  private syncStatus(): void {
    const name = baseOf(this.path);
    this.ctx.setStatus({
      title: name,
      file: name,
      encoding: `Markdown · ${this.encLabel}`,
      position: `第 ${this.idx + 1}/${this.siblings.length} 份`,
      mode: `模式: ${this.asSource ? "源码" : "渲染"}`,
      display: this.ctx.autoscroll.isScrolling() ? "滚屏中" : "-",
    });
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  deactivate(): void {
    openViews.delete(this);
    this.unwatch?.();
    window.clearTimeout(this.scrollTimer);
    this.revokeBlobs();
  }

  private revokeBlobs(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
  }
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
  name: "Markdown 查看",
  version: "1.1.0",
  description: "渲染 Markdown 为富文本阅读视图（跟随阅读主题、大纲面板、自动滚屏）",
  extensions: [".md", ".markdown", ".mdown"],
  // loader 形状校验强制要求 open 存在（"缺少 open(ctx) 方法"）；多实例宿主实际走
  // createView().open(ctx)，此 open 仅作 loader 校验占位（宿主在 createView 存在时不会调用）
  open: (ctx) => new MarkdownView().open(ctx),
  createView: () => new MarkdownView(),
  menu: (): MenuItemDef[] => [
    {
      label: "渲染显示",
      checked: () => !prefSource,
      action: () => openViews.forEach((v) => v.setSource(false)),
    },
    {
      label: "源码显示",
      checked: () => prefSource,
      action: () => openViews.forEach((v) => v.setSource(true)),
    },
  ],
};

export default plugin;
