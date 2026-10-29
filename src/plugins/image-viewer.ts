/* 图片查看插件：查看常见图片格式（含 zip 内图片）。
   支持：缩放（滚轮以鼠标为焦点）/旋转/缩放模式下拉（适应窗口·适宽·适高·原始大小）/
   播放模式下拉（滚屏/幻灯，选中才显示对应设置项）：自动滚屏（向下·向右·向左，
   无缝拼接预加载）/幻灯播放，跨目录与跨压缩包接续。
   多实例：视图态全部迁入 ImageView 类（每个标签页独立实例）；
   用户偏好与内容缓存（dimCache/listCache）保持模块级共享。 */
import { api } from "../api";
import * as app from "../app";
import { showDropdown } from "../dropdown";
import { activeViewId, instanceOf, pluginSetting, setPluginSetting } from "./registry";
import type { MenuItemDef } from "../dropdown";
import type { PluginOpenContext, PluginViewInstance, ReadBookPlugin } from "./types";

const PID = "image-viewer";
const EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

type Direction = "down" | "ltr" | "rtl";
type FitMode = "contain" | "width" | "height" | "custom";

/* 固定设置（持久化于 settings.pluginSettings；模块级共享用户偏好） */
let direction: Direction = pluginSetting<Direction>(PID, "direction", "down");
let stitch = pluginSetting<boolean>(PID, "stitch", true);
let slideSeconds = pluginSetting<number>(PID, "slideSeconds", 5);
let scrollPxPerSec = pluginSetting<number>(PID, "scrollPxPerSec", 100);
let playMode = pluginSetting<"scroll" | "slide">(PID, "playMode", "scroll"); // 宿主播放按钮按此模式开始

function saveSetting(key: string, val: string | number | boolean): void {
  setPluginSetting(PID, key, val);
}

/* 内容缓存（纯内容派生，跨实例命中是收益） */
const dimCache = new Map<string, { w: number; h: number }>();
const listCache = new Map<string, string[]>(); // 容器 → 图片路径列表（键含排序开关，切换后旧序缓存自然失效）
const TAPE_GAP = 16; // 与 .imgv-strip 的 gap 保持一致（滚动补偿用）

/** 菜单动作的视图侧落点：当前激活视图若为本插件的实例则返回之
 *  （无视图/其他插件视图激活时为 null，菜单只改设置不动视图，与旧版行为一致） */
function liveView(): ImageView | null {
  const inst = instanceOf(activeViewId());
  return inst instanceof ImageView ? inst : null;
}

const extMime = (name: string): string => {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && MIME[m[0]]) || "application/octet-stream";
};
const baseName = (p: string): string => p.split(/[\\/:]+/).filter(Boolean).pop() || p;
const parentOf = (p: string): string => {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
};

async function loadBytes(path: string): Promise<Uint8Array> {
  const m = path.match(/^(.+\.zip)::(.+)$/i);
  const buf = m ? await api.readZipBytes(m[1], m[2]) : await api.readFileBytes(path);
  return new Uint8Array(buf);
}

async function ensureDims(path: string, url: string): Promise<{ w: number; h: number }> {
  const hit = dimCache.get(path);
  if (hit) return hit;
  const img = new Image();
  img.src = url;
  // load 事件比 decode() 更早可用；带 3 秒兜底防止个别环境不触发
  await new Promise<void>((res) => {
    img.onload = () => res();
    img.onerror = () => res();
    window.setTimeout(res, 3000);
  });
  const d = { w: img.naturalWidth || 600, h: img.naturalHeight || 400 };
  dimCache.set(path, d);
  return d;
}

/* ========== 容器（目录 / zip）与播放队列 ========== */

type Container = { type: "dir" | "zip"; path: string };

function containerOf(path: string): Container {
  const m = path.match(/^(.+\.zip)::/i);
  if (m) return { type: "zip", path: m[1] };
  return { type: "dir", path: parentOf(path) };
}

async function listImages(c: Container): Promise<string[]> {
  // 缓存键含排序开关：切换后旧序缓存自然失效
  const key = (app.state.store.settings.naturalSort ? "N\n" : "Z\n") + c.path;
  const hit = listCache.get(key);
  if (hit) return hit;
  let out: string[] = [];
  try {
    if (c.type === "zip") {
      const all = await api.listZip(c.path, app.state.store.settings.naturalSort);
      const zImgs = all.filter((n) => IMAGE_RE.test(n));
      // 自然排序开：后端已排好，信任其顺序（与侧栏一致）；关：保留原 zh 典序重排
      out = (app.state.store.settings.naturalSort
        ? zImgs
        : zImgs.sort((a, b) => a.localeCompare(b, "zh"))
      ).map((n) => `${c.path}::${n}`);
    } else {
      const entries = await api.listDir(c.path, app.state.store.settings.naturalSort);
      const dImgs = entries.filter((e) => !e.isDir && IMAGE_RE.test(e.name));
      // 自然排序开：后端已排好，信任其顺序（与侧栏一致）；关：保留原 zh 典序重排
      out = (app.state.store.settings.naturalSort
        ? dImgs
        : dImgs.sort((a, b) => a.name.localeCompare(b.name, "zh"))
      ).map((e) => e.path);
    }
  } catch {
    out = [];
  }
  listCache.set(key, out);
  return out;
}

/** 播完当前容器后，取同级的下一个容器（list_dir 顺序：目录在前，zip 文件随后） */
async function nextContainer(c: Container): Promise<Container | null> {
  try {
    const entries = await api.listDir(parentOf(c.path), app.state.store.settings.naturalSort);
    const containers: Container[] = [];
    for (const e of entries) {
      if (e.isDir) containers.push({ type: "dir", path: e.path });
      else if (/\.zip$/i.test(e.name)) containers.push({ type: "zip", path: e.path });
    }
    const idx = containers.findIndex((x) => x.path === c.path);
    if (idx === -1) return containers[0] ?? null;
    return containers[idx + 1] ?? null;
  } catch {
    return null;
  }
}

/** 后退跨容器：取同级的上一个容器（与 nextContainer 同序反向） */
async function prevContainer(c: Container): Promise<Container | null> {
  try {
    const entries = await api.listDir(parentOf(c.path), app.state.store.settings.naturalSort);
    const containers: Container[] = [];
    for (const e of entries) {
      if (e.isDir) containers.push({ type: "dir", path: e.path });
      else if (/\.zip$/i.test(e.name)) containers.push({ type: "zip", path: e.path });
    }
    const idx = containers.findIndex((x) => x.path === c.path);
    if (idx === -1) return containers[containers.length - 1] ?? null;
    return containers[idx - 1] ?? null;
  } catch {
    return null;
  }
}

/* ========== 纯 DOM 辅助 ========== */

function frameEl(url: string): { el: HTMLElement; img: HTMLImageElement } {
  const el = document.createElement("div");
  el.className = "imgv-frame";
  const img = document.createElement("img");
  img.className = "imgv-img";
  img.src = url;
  el.appendChild(img);
  return { el, img };
}

const dirLabel = (d: Direction): string =>
  d === "down" ? "从上向下" : d === "ltr" ? "从左至右" : "从右至左";

/* ========== 视图实例 ========== */

/** 胶片带：观看顺序窗口（上一张/当前/下一张），DOM 顺序在 rtl 下反转。
   每帧按自身展示要求（适应窗口/适宽/适高/自定义）独立计算倍率。 */
interface TapeItem {
  path: string;
  url: string;
  w: number;
  h: number;
  ratio: number;
  el: HTMLElement;
}

class ImageView implements PluginViewInstance {
  viewId = "";
  private ctx: PluginOpenContext | null = null;
  private fitMode: FitMode = "contain";
  private zoom = 1; // fitMode === "custom" 时生效
  private rotation = 0; // 仅作用于当前帧
  private globalIdx = 0; // 当前图在 ctx.siblings 中的下标
  private advancing = false;
  private bottomSince = 0;

  /* 播放状态 */
  private slideTimer = 0;
  private slideOn = false;
  private scrollOn = false;
  private scrollSuspended = false; // 用户滚轮缩放时置位；停止操作 2 秒后自动恢复（否则会永久卡停）
  private suspendedAt = 0;
  private scrollRaf = 0; // rAF 循环 id
  private scrollFallback = 0; // rAF 停摆时的兜底定时器 id
  private lastFrameTs = 0;

  /* 胶片带（观看顺序窗口，DOM 顺序在 rtl 下反转） */
  private tape: TapeItem[] = [];
  private tapeCur = 0; // 当前图在 tape 中的下标

  private urlCache = new Map<string, string>();
  /** 同路径并发加载去重：appendTapeFrame 的延迟补齐会在滚动循环里反复触发，
   *  不去重会重复读字节、重复建 Blob URL 且泄漏（urlCache 只留最后一个） */
  private urlInflight = new Map<string, Promise<string>>();
  private preloadInflight = new Set<string>();
  private preheatedFor: string | null = null; // 已为其预热"下一容器"的容器路径
  private layoutRetry = 0;
  /** 仅激活 tab 的实例响应全局事件（当前无 window 级监听，滚轮挂在面板内随面板销毁）；公开字段备用 */
  activeVisible = false;

  /** resize 监听器：类字段箭头包装，注册/移除引用同一函数对象且 this 绑定本实例 */
  private readonly onResizeHandler = (): void => this.onResize();

  /* ========== DOM 查询（实例面板内） ========== */

  private q<T extends Element>(sel: string): T | null {
    return this.ctx ? (this.ctx.host.querySelector(sel) as T | null) : null;
  }

  private siblingPath(i: number): string | null {
    return this.ctx && i >= 0 && i < this.ctx.siblings.length ? this.ctx.siblings[i] : null;
  }

  /* ========== 字节 / URL ========== */

  private async ensureUrl(path: string): Promise<string> {
    const hit = this.urlCache.get(path);
    if (hit) return hit;
    const flying = this.urlInflight.get(path);
    if (flying) return flying;
    const task = (async () => {
      const bytes = await loadBytes(path);
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: extMime(path) });
      const url = URL.createObjectURL(blob);
      this.urlCache.set(path, url);
      if (this.urlCache.size > 8) {
        // 淘汰最旧的非当前胶片带条目：带内帧的 URL 被 revoke 会导致未解码帧显示失败
        const inTape = new Set(this.tape.map((t) => t.path));
        const oldest = [...this.urlCache.keys()].find((k) => !inTape.has(k));
        if (oldest) {
          const u = this.urlCache.get(oldest);
          this.urlCache.delete(oldest);
          if (u) URL.revokeObjectURL(u);
        }
      }
      return url;
    })();
    this.urlInflight.set(path, task);
    try {
      return await task;
    } finally {
      this.urlInflight.delete(path);
    }
  }

  /* ========== 视图渲染 ========== */

  /** 帧图片实际加载完成后校正尺寸：ensureDims 超时/失败时的 600×400 兜底值
   *  会永久驻留 dimCache（布局持续错误），此处按 naturalWidth 自愈并重排 */
  private watchFrameDims(path: string, img: HTMLImageElement): void {
    img.addEventListener("load", () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return;
      const d = dimCache.get(path);
      if (d && d.w === w && d.h === h) return;
      dimCache.set(path, { w, h });
      const item = this.tape.find((t) => t.path === path);
      if (item) {
        item.w = w;
        item.h = h;
        this.applyLayout();
      }
    });
  }

  /** 重建视图：以 globalIdx 为当前帧；拼接+滚屏时窗口三帧（预加载下一张），否则单帧 */
  private async renderWindow(g: number): Promise<void> {
    if (!this.ctx) return;
    this.globalIdx = Math.max(0, Math.min(g, this.ctx.siblings.length - 1));
    const useTape = stitch && this.scrollOn;
    const paths: string[] = useTape
      ? [
          this.siblingPath(this.globalIdx - 1),
          this.siblingPath(this.globalIdx),
          this.siblingPath(this.globalIdx + 1),
        ].filter((p): p is string => !!p)
      : [this.ctx.siblings[this.globalIdx]];

    const urls = await Promise.all(paths.map((p) => this.ensureUrl(p)));
    const dims: { w: number; h: number }[] = [];
    for (let i = 0; i < paths.length; i++) {
      const hit = dimCache.get(paths[i]);
      dims.push(hit ?? (await ensureDims(paths[i], urls[i])));
      dimCache.set(paths[i], dims[i]);
    }

    // DOM 顺序：rtl 时观看顺序反转（首张在最右）
    const order = direction === "rtl" ? [...paths.keys()].reverse() : [...paths.keys()];
    const strip = this.q<HTMLElement>(".imgv-strip")!;
    strip.innerHTML = "";
    strip.className = `imgv-strip dir-${direction}`;
    this.tape = [];
    let curDom = 0;
    order.forEach((k, domIdx) => {
      const fe = frameEl(urls[k]);
      strip.appendChild(fe.el);
      this.tape.push({ path: paths[k], url: urls[k], w: dims[k].w, h: dims[k].h, ratio: 1, el: fe.el });
      this.watchFrameDims(paths[k], fe.img);
      if (paths[k] === this.ctx!.siblings[this.globalIdx]) curDom = domIdx;
    });
    this.tapeCur = curDom;

    this.applyLayout();
    this.alignCurrent();
    this.updateLabels();
    // 预解码各帧 + 预加载后续帧（拼接滚动无缝的关键）；单帧模式预载前后一张，幻灯/翻页零等待
    for (const item of this.tape) {
      (item.el.querySelector(".imgv-img") as HTMLImageElement | null)?.decode?.().catch(() => {});
    }
    if (useTape) {
      this.ensureTapeAhead(); // 窄帧同显多张时初始三帧装不满滚动空间，扩带到覆盖视口
      void this.preloadAhead(this.globalIdx + 2);
    } else {
      void this.preloadAhead(this.globalIdx + 1);
      void this.preloadAhead(this.globalIdx - 1);
    }
  }

  private alignCurrent(): void {
    const stage = this.q<HTMLElement>(".imgv-stage");
    const cur = this.tape[this.tapeCur];
    if (!stage || !cur) return;
    const sr = stage.getBoundingClientRect();
    const fr = cur.el.getBoundingClientRect();
    if (direction === "down") stage.scrollTop += fr.top - sr.top;
    else if (direction === "ltr") stage.scrollLeft += fr.left - sr.left;
    else stage.scrollLeft += fr.right - sr.right;
  }

  /** 摘除观看顺序最前的帧（down/ltr：DOM 头部已滚出视口，摘除后补偿滚动位置） */
  private dropTapeHead(): void {
    const dropped = this.tape.shift()!;
    this.tapeCur = Math.max(0, this.tapeCur - 1);
    const stage = this.q<HTMLElement>(".imgv-stage")!;
    if (direction === "down") stage.scrollTop -= dropped.el.offsetHeight + TAPE_GAP;
    else stage.scrollLeft -= dropped.el.offsetWidth + TAPE_GAP;
    dropped.el.remove();
  }

  /** 摘除观看顺序最前的帧（rtl 专用）：rtl 的 tape 为 DOM 序（观看序反转），
   *  已看过的旧帧在 DOM 最右 = tape 尾；摘尾不影响左侧内容位置，无需补偿 */
  private dropTapeTail(): void {
    const dropped = this.tape.pop()!;
    dropped.el.remove();
  }

  /** 动态补帧：保证前进方向带内未进入视口的冗余 ≥ 视口尺寸。
   *  竖版图横向滚（或横版图向下滚）时单帧小于视口、视口能同显多帧，
   *  固定三帧窗口会让胶片带毫无溢出（滚不动）或溢出不足一帧（边界补偿被钳位），
   *  只有冗余 ≥ 视口时"下一帧前缘到达视口前缘"的推进条件才能在正确时机触发，
   *  摘帧补偿也才始终有效。幂等：帧已在带中/无下一张时直接返回。 */
  private ensureTapeAhead(): void {
    const stage = this.q<HTMLElement>(".imgv-stage");
    if (!this.ctx || !stage || !this.tape.length) return;
    const horizontal = direction !== "down";
    for (let guard = 0; guard < 12; guard++) {
      // 前进方向带内最远帧：down/ltr 在 DOM 尾部；rtl 在 DOM 头部（观看序反转）
      const edge = direction === "rtl" ? this.tape[0] : this.tape[this.tape.length - 1];
      const sr = stage.getBoundingClientRect();
      const r = edge.el.getBoundingClientRect();
      const ahead =
        direction === "down"
          ? r.bottom - sr.bottom
          : direction === "ltr"
            ? r.right - sr.right
            : sr.left - r.left;
      if (ahead >= (horizontal ? stage.clientWidth : stage.clientHeight)) return;
      const idx = this.ctx.siblings.indexOf(edge.path);
      const p = this.siblingPath(idx + 1);
      if (!p) return; // 容器已无下一张：剩余溢出不足属容器尾部正常状态（停留后跨容器）
      const before = this.tape.length;
      this.appendTapeFrame(p);
      if (this.tape.length === before) return; // 字节还在后台补齐，等滚动循环下轮再查
    }
  }

  /** 追加一帧到胶片带尾部（url/尺寸应已预加载缓存；未就绪时后台补齐后再追加） */
  private appendTapeFrame(path: string): void {
    if (!this.ctx || this.tape.some((t) => t.path === path)) return;
    const url = this.urlCache.get(path);
    const dims = dimCache.get(path);
    if (!url || !dims) {
      void (async () => {
        try {
          const u = await this.ensureUrl(path);
          const d = await ensureDims(path, u);
          this.appendTapeFrameReady(path, u, d);
        } catch {
          /* 加载失败忽略 */
        }
      })();
      return;
    }
    this.appendTapeFrameReady(path, url, dims);
  }

  private appendTapeFrameReady(path: string, url: string, d: { w: number; h: number }): void {
    if (!this.ctx || this.tape.some((t) => t.path === path)) return;
    const fe = frameEl(url);
    const item: TapeItem = { path, url, w: d.w, h: d.h, ratio: 1, el: fe.el };
    const strip = this.q<HTMLElement>(".imgv-strip")!;
    if (direction === "rtl") {
      strip.insertBefore(fe.el, strip.firstChild);
      this.tape.unshift(item);
      this.tapeCur++; // 头部插入使既有帧索引整体 +1，当前帧指针同步右移
    } else {
      strip.appendChild(fe.el);
      this.tape.push(item);
    }
    this.applyLayout();
    if (direction === "rtl") {
      // 左侧追加使内容整体右移：补偿滚动位置
      const stage = this.q<HTMLElement>(".imgv-stage")!;
      stage.scrollLeft += fe.el.offsetWidth + TAPE_GAP;
    }
    this.watchFrameDims(path, fe.img);
    fe.img.decode?.().catch(() => {});
  }

  /** 拼接滚屏：滚过边界增量推进——当前帧元素不动，仅摘除滚出帧、追加预加载帧。
   *  全程同步无网络等待，边界无卡顿。tape 为 DOM 序：down/ltr 与观看序相同
   *  （下一帧在 tapeCur+1，摘头）；rtl 观看序反转（下一帧在 tapeCur-1，摘尾）。 */
  private promoteStep(): void {
    if (!this.ctx || !this.siblingPath(this.globalIdx + 1)) return;
    const nextPath = this.siblingPath(this.globalIdx + 1);
    // 下一帧尚未进带（字节仍在后台补）：先补齐，就绪后由滚动循环再次推进
    if (nextPath && !this.tape.some((t) => t.path === nextPath)) {
      this.appendTapeFrame(nextPath);
      return;
    }
    this.globalIdx++;
    // 追加新的下一帧（预加载缓存命中时同步完成）
    const p = this.siblingPath(this.globalIdx + 1);
    if (p) this.appendTapeFrame(p);
    this.ensureTapeAhead();
    // 按路径重定位当前帧下标：rtl 头部插入会使整体索引偏移，直接查找最稳
    const cur2 = this.siblingPath(this.globalIdx);
    const ci = cur2 ? this.tape.findIndex((t) => t.path === cur2) : -1;
    if (ci >= 0) this.tapeCur = ci;
    // 摘除已完全滚出视口的旧帧：多帧同显时带内帧可能仍在视口中，摘除可见帧
    // 会产生无法补偿的位移突变（滚动余量不足时补偿被钳位）。只在完全不可见时摘，
    // 容器尾部退化为纯标签推进（无 DOM 变化，视口稳定）。down/ltr 摘头（补偿滚动）；rtl 摘尾。
    const stage = this.q<HTMLElement>(".imgv-stage");
    if (stage) {
      const sr = stage.getBoundingClientRect();
      if (direction === "rtl") {
        while (this.tape.length - 1 - this.tapeCur > 1) {
          if (this.tape[this.tape.length - 1].el.getBoundingClientRect().left <= sr.right + 1) break; // 仍可见
          this.dropTapeTail();
        }
      } else {
        while (this.tapeCur > 1) {
          const r = this.tape[0].el.getBoundingClientRect();
          const visible = direction === "down" ? r.bottom > sr.top + 1 : r.right > sr.left + 1;
          if (visible) break; // 仍可见
          this.dropTapeHead();
        }
      }
    }
    this.updateLabels();
    void this.preloadAhead(this.globalIdx + 2);
    this.syncButtons();
  }

  /** 当前帧路径：globalIdx=-1 为跨容器过渡态（视口仍是旧容器尾帧），取胶片带当前帧兜底 */
  private currentPath(): string {
    if (!this.ctx) return "";
    return this.ctx.siblings[this.globalIdx] || this.tape[this.tapeCur]?.path || this.ctx.path;
  }

  private updateLabels(): void {
    if (!this.ctx) return;
    const path = this.currentPath();
    const nameEl = this.q<HTMLElement>(".imgv-name");
    if (nameEl) {
      nameEl.textContent = baseName(path);
      nameEl.title = path;
    }
    const pageEl = this.q<HTMLElement>(".imgv-page");
    if (pageEl)
      pageEl.textContent =
        this.ctx.siblings.length > 1 && this.globalIdx >= 0
          ? `${this.globalIdx + 1}/${this.ctx.siblings.length}`
          : "";
    this.syncStatus();
  }

  /** 向宿主上报视图状态：窗口标题/右上角显示打开的文件（zip 内图片显示 zip 名），
   *  状态栏"文件"格显示当前查看的图片；其余各格随缩放与播放状态更新。
   *  宿主在插件视图关闭时自动恢复文本状态，这里无需处理退场。 */
  private syncStatus(): void {
    if (!this.ctx) return;
    const path = this.currentPath();
    const cur = this.tape[this.tapeCur];
    const m = path.match(/^(.+\.zip)::/i);
    const opened = baseName(m ? m[1] : path); // 打开的文件：zip 自身或独立图片
    this.ctx.setStatus({
      title: opened,
      file: baseName(path),
      encoding: cur ? `${this.ctx.ext.replace(".", "").toUpperCase()} ${cur.w}×${cur.h}` : undefined,
      position:
        this.ctx.siblings.length > 1 && this.globalIdx >= 0
          ? `第 ${this.globalIdx + 1}/${this.ctx.siblings.length} 张`
          : undefined,
      mode: `模式: ${this.fitLabel()}`,
      display: this.slideOn
        ? `幻灯 ${slideSeconds}s`
        : this.scrollOn
          ? `滚屏·${dirLabel(direction)}`
          : "查看图片",
    });
  }

  /** 播放接近容器末尾时，后台预热下一个容器（图片列表 + 首图字节/解码），
   *  跨容器切换零等待 */
  private preheatNextContainer(): void {
    if (!this.ctx) return;
    const cur = containerOf(this.ctx.path);
    if (this.preheatedFor === cur.path) return;
    this.preheatedFor = cur.path;
    void (async () => {
      try {
        const nxt = await nextContainer(cur);
        if (!nxt) return;
        const imgs = await listImages(nxt);
        const first = imgs[0];
        if (!first) return;
        const url = await this.ensureUrl(first);
        const img = new Image();
        img.src = url;
        await img.decode().catch(() => {});
        dimCache.set(first, { w: img.naturalWidth || 600, h: img.naturalHeight || 400 });
      } catch {
        /* 预热失败忽略，切换时按原路径加载 */
      }
    })();
  }

  /** 预加载：字节 → URL → 尺寸 → 解码，全部进缓存（滚动跨图无缝的关键）。
   *  幂等：已就绪或正在加载的直接跳过，滚动循环里可放心高频调用。 */
  private async preloadAhead(index: number): Promise<void> {
    const p = this.siblingPath(index);
    if (!p || this.preloadInflight.has(p)) return;
    if (this.urlCache.has(p) && dimCache.has(p)) return;
    this.preloadInflight.add(p);
    try {
      const url = await this.ensureUrl(p);
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => {}); // 预解码：进入视口时首帧直接绘制
      dimCache.set(p, { w: img.naturalWidth || 600, h: img.naturalHeight || 400 });
    } catch {
      /* 预加载失败忽略，滚到时再试 */
    } finally {
      this.preloadInflight.delete(p);
    }
  }

  private applyLayout(): void {
    if (!this.ctx) return;
    const stage = this.q<HTMLElement>(".imgv-stage");
    const cur = this.tape[this.tapeCur];
    const zoomEl = this.q<HTMLElement>(".imgv-zoom");
    if (!stage || !cur || !zoomEl) return;

    // 宿主短暂不可见/布局未就绪时 stage 尺寸会塌缩：延迟重试，避免把图片缩到地板尺寸
    if (stage.clientWidth < 80 && this.layoutRetry < 40) {
      this.layoutRetry++;
      setTimeout(() => this.applyLayout(), 16);
      return;
    }
    this.layoutRetry = 0;

    const availW = Math.max(40, stage.clientWidth - 24);
    const availH = Math.max(40, stage.clientHeight - 24);

    const ratioFor = (item: TapeItem, rot: number): number => {
      const s = rot % 180 !== 0;
      const visW = s ? item.h : item.w;
      const visH = s ? item.w : item.h;
      let r: number;
      if (this.fitMode === "contain") r = Math.min(availW / visW, availH / visH);
      else if (this.fitMode === "width") r = availW / visW;
      else if (this.fitMode === "height") r = availH / visH;
      else r = this.zoom;
      return Math.min(20, Math.max(0.02, r));
    };

    // 每帧按自身展示要求独立计算倍率（当前帧决定整体缩放基准），仍是互相独立的图片
    for (const item of this.tape) {
      const isCur = item === cur;
      const rot = isCur ? this.rotation : 0;
      const r = ratioFor(item, rot);
      item.ratio = r;
      const w = item.w * r;
      const h = item.h * r;
      const s = rot % 180 !== 0;
      item.el.style.width = (s ? h : w) + "px";
      item.el.style.height = (s ? w : h) + "px";
      const im = item.el.querySelector(".imgv-img") as HTMLImageElement;
      im.style.width = w + "px";
      im.style.height = h + "px";
      im.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
    }

    zoomEl.textContent = `${cur.w}×${cur.h} · ${Math.round(cur.ratio * 100)}%`;
    this.layoutRetry = 0;
    this.syncFitButton();
    this.syncStatus(); // 缩放比例/适应模式变化 → 状态栏"模式"格随之更新
  }

  /** 当前缩放模式/比例的显示文案（下拉按钮与状态栏"模式"格共用） */
  private fitLabel(): string {
    const cur = this.tape[this.tapeCur];
    switch (this.fitMode) {
      case "contain":
        return "适应窗口";
      case "width":
        return "适合宽度";
      case "height":
        return "适合高度";
      default: {
        const r = cur?.ratio ?? this.zoom;
        return r === 1 ? "1:1" : `${Math.round(r * 100)}%`;
      }
    }
  }

  private syncFitButton(): void {
    const btn = this.q<HTMLElement>(`button[data-act="fitmenu"]`);
    if (btn) {
      btn.textContent = this.fitLabel();
      btn.title = "缩放模式：适应窗口 / 适合宽度 / 适合高度 / 原始大小";
    }
  }

  private setFit(mode: FitMode): void {
    this.fitMode = mode;
    this.applyLayout();
  }

  /** 缩放模式下拉（适应窗口/适宽/适高/原始大小） */
  private showFitMenu(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    showDropdown(
      [
        { label: "缩放模式", disabled: true },
        { sep: true },
        { label: "适应窗口", checked: () => this.fitMode === "contain", action: () => this.setFit("contain") },
        { label: "适合宽度", checked: () => this.fitMode === "width", action: () => this.setFit("width") },
        { label: "适合高度", checked: () => this.fitMode === "height", action: () => this.setFit("height") },
        {
          label: "原始大小 (1:1)",
          checked: () => this.fitMode === "custom" && (this.tape[this.tapeCur]?.ratio ?? this.zoom) === 1,
          action: () => {
            this.fitMode = "custom";
            this.zoom = 1;
            this.applyLayout();
          },
        },
      ],
      r.left,
      r.bottom + 4
    );
  }

  /* ========== 焦点缩放 ========== */

  /** 以 (px,py)（相对 stage 视口）为焦点缩放，光标下的内容点保持不动。
   *  缩放围绕帧中心发生：点' = 中心new + (点 - 中心old) × f。 */
  private zoomAt(factor: number, px: number, py: number): void {
    const stage = this.q<HTMLElement>(".imgv-stage");
    const frame = this.tape[this.tapeCur]?.el ?? this.q<HTMLElement>(".imgv-frame");
    if (!stage || !frame) return;
    this.fitMode = "custom";
    const oldW = frame.getBoundingClientRect().width;
    const oldH = frame.getBoundingClientRect().height;
    const bx = stage.scrollLeft + px; // 光标处的内容坐标（视觉空间）
    const by = stage.scrollTop + py;
    this.zoom = Math.min(20, Math.max(0.02, this.zoom * factor));
    this.applyLayout();
    const newW = frame.getBoundingClientRect().width;
    const newH = frame.getBoundingClientRect().height;
    const f = newW / oldW;
    stage.scrollLeft = Math.max(0, newW / 2 + (bx - oldW / 2) * f - px);
    stage.scrollTop = Math.max(0, newH / 2 + (by - oldH / 2) * f - py);
  }

  /* ========== 播放：幻灯 + 自动滚屏 ========== */

  private stopScrollLoop(): void {
    cancelAnimationFrame(this.scrollRaf);
    clearInterval(this.scrollFallback);
    this.scrollRaf = 0;
    this.scrollFallback = 0;
  }

  private stopTimers(): void {
    clearInterval(this.slideTimer);
    this.slideTimer = 0;
    this.stopScrollLoop();
  }

  private startScrollLoop(): void {
    this.stopScrollLoop();
    const stage = this.q<HTMLElement>(".imgv-stage");
    if (!stage) return;
    this.bottomSince = 0;
    let last = performance.now();
    this.lastFrameTs = last;

    const step = (now: number, dt: number): void => {
      if (this.scrollSuspended) {
        // 缩放暂停期间不推进；距最后一次滚轮 2 秒后自动恢复滚屏
        if (now - this.suspendedAt < 2000) return;
        this.scrollSuspended = false;
      }
      const noOverflowY = stage.scrollHeight <= stage.clientHeight + 2;
      const noOverflowX = stage.scrollWidth <= stage.clientWidth + 2;
      const atEnd =
        direction === "down"
          ? noOverflowY || stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
          : direction === "ltr"
            ? noOverflowX || stage.scrollLeft + stage.clientWidth >= stage.scrollWidth - 2
            : noOverflowX || stage.scrollLeft <= 2;
      // 拼接模式：滚过边界增量推进——当前帧元素不动，仅摘除滚出帧、追加预加载帧。
      // 下一帧前缘到达视口前缘（帧大于视口）即推进；帧≤视口时（窄帧同显多张）
      // 前缘到不了前缘，由 ensureTapeAhead 保证的溢出空间滚动推进。两种情况都不停留。
      if (stitch) {
        this.ensureTapeAhead();
        // 下一帧在观看顺序侧：down/ltr 为 tapeCur+1；rtl 的 tape 是 DOM 序反转，为 tapeCur-1
        const next = direction === "rtl" ? this.tape[this.tapeCur - 1] : this.tape[this.tapeCur + 1];
        if (next) {
          const sr = stage.getBoundingClientRect();
          const r = next.el.getBoundingClientRect();
          // 推进基准 = 下一帧前缘与视口前缘对齐（与 alignCurrent 同基准，任意帧宽下成立）
          const enter =
            direction === "down"
              ? r.top - sr.top <= 0
              : direction === "ltr"
                ? r.left - sr.left <= 0
                : r.right - sr.right >= 0;
          // 下一帧开始进入视口就预热下下张：比边界推进再早一屏启动加载（幂等，已缓存自动跳过）
          const entering =
            direction === "down"
              ? r.top - sr.top <= stage.clientHeight
              : direction === "ltr"
                ? r.left - sr.left <= stage.clientWidth
                : r.right - sr.left >= 0;
          if (entering) void this.preloadAhead(this.globalIdx + 2);
          // 只认对齐基准推进：ensureTapeAhead 保证还有下一张时对齐必然可达；
          // 此前"滚到底立即推进"（atEnd && !noOverflow）在多帧同显时会对可见帧连环
          // promote + 摘除，产生跳帧与位移突变，容器尾部应交给下方 atEnd 停留逻辑。
          if (enter) {
            this.promoteStep();
            return;
          }
        }
      }
      // 图片装得下（无溢出）或真正到底/到边且后面已无帧：停留 1.5 秒再换，避免瞬间连跳
      if (atEnd) {
        this.preheatNextContainer(); // 幂等：接近容器末尾时后台预热下一个容器
        if (!this.bottomSince) this.bottomSince = now;
        if (now - this.bottomSince >= 1500) {
          this.bottomSince = 0;
          void this.advance();
          return;
        }
        return;
      }
      this.bottomSince = 0;
      if (direction === "down") stage.scrollTop += (scrollPxPerSec * dt) / 1000;
      else if (direction === "ltr") stage.scrollLeft += (scrollPxPerSec * dt) / 1000;
      else stage.scrollLeft -= (scrollPxPerSec * dt) / 1000;
    };

    // rAF 主循环：60fps 逐帧推进，滚动平滑
    const tick = (ts: number) => {
      if (!this.scrollOn || !this.ctx) {
        this.stopScrollLoop();
        return;
      }
      if (this.advancing) {
        this.lastFrameTs = ts;
        last = ts;
        this.scrollRaf = requestAnimationFrame(tick); // 换图进行中，保持循环等待
        return;
      }
      const dt = Math.min(100, ts - last);
      last = ts;
      this.lastFrameTs = ts;
      step(ts, dt);
      this.scrollRaf = requestAnimationFrame(tick);
    };
    this.scrollRaf = requestAnimationFrame(tick);

    // 看门狗：rAF 停摆（窗口被遮挡/后台标签）时以 10Hz 兜底推进，保证功能不中断
    this.scrollFallback = window.setInterval(() => {
      if (!this.scrollOn || !this.ctx) {
        this.stopScrollLoop();
        return;
      }
      const now = performance.now();
      if (this.advancing || now - this.lastFrameTs < 400) return; // rAF 正常工作时跳过
      const dt = Math.min(400, now - last);
      last = now;
      this.lastFrameTs = now;
      step(now, dt);
    }, 100);
  }

  private restartTimers(): void {
    if (this.slideOn) {
      clearInterval(this.slideTimer);
      this.slideTimer = window.setInterval(() => void this.advance(), Math.max(1, slideSeconds) * 1000);
    }
    if (this.scrollOn) {
      this.scrollSuspended = false;
      this.startScrollLoop();
    }
    this.syncButtons();
  }

  /** 找同级的下一个有图片的容器（跳过空容器，防环，最多找 200 个） */
  private async nextContainerWithImages(): Promise<string[] | null> {
    if (!this.ctx) return null;
    const visited = new Set<string>([containerOf(this.ctx.path).path]);
    let c: Container | null = containerOf(this.ctx.path);
    for (let i = 0; i < 200; i++) {
      c = await nextContainer(c!);
      if (!c || visited.has(c.path)) return null;
      visited.add(c.path);
      const imgs = await listImages(c);
      if (imgs.length > 0) return imgs;
    }
    return null;
  }

  /** 找同级的上一个有图片的容器（跳过空容器，防环，最多找 200 个） */
  private async prevContainerWithImages(): Promise<string[] | null> {
    if (!this.ctx) return null;
    const visited = new Set<string>([containerOf(this.ctx.path).path]);
    let c: Container | null = containerOf(this.ctx.path);
    for (let i = 0; i < 200; i++) {
      c = await prevContainer(c!);
      if (!c || visited.has(c.path)) return null;
      visited.add(c.path);
      const imgs = await listImages(c);
      if (imgs.length > 0) return imgs;
    }
    return null;
  }

  /** 前进一张：容器内还有下一张就翻下一张（拼接滚屏走增量推进），
   *  容器内全部播完才跳同级下一个目录 / zip 文件 */
  private async advance(): Promise<void> {
    if (!this.ctx || this.advancing) return;
    if (this.siblingPath(this.globalIdx + 1)) {
      // 拼接滚屏中：同容器内增量推进（无重绘无等待，边界无卡顿）
      if (stitch && this.scrollOn) {
        this.promoteStep();
        return;
      }
      this.advancing = true;
      try {
        await this.goTo(this.globalIdx + 1);
      } finally {
        this.advancing = false;
        this.syncButtons();
      }
      return;
    }
    this.advancing = true;
    try {
      // 容器已到最后一张：跨容器接续（找下一个有图的容器，预热缓存命中 → 即时）
      const wasPlaying = this.slideOn || this.scrollOn; // 等待前的播放意图
      const imgs = await this.nextContainerWithImages();
      if (!this.ctx) return; // 等待期间视图已关闭：放弃过期切换
      if (!imgs) {
        if (wasPlaying) this.stopPlayback(); // 播放已到尽头：停掉定时器并同步宿主按钮状态
        app.toast("播放结束：后面没有更多图片了");
        return;
      }
      if (wasPlaying && !this.slideOn && !this.scrollOn) return; // 等待期间播放已被停止：放弃过期切换
      if (stitch && this.scrollOn) {
        // 拼接滚屏：只追加新容器首帧，当前帧与滚动位置都不动——旧容器尾帧占住 tapeCur
        // （globalIdx=-1 过渡态），滚入新首帧时由 promoteStep 常规推进并摘除旧帧。
        // 不能立即摘除旧帧：摘除使内容高度塌缩、scrollTop 钳到 0，视口跳回当前帧开头重滚一遍。
        this.ctx.siblings = imgs;
        this.ctx.path = imgs[0];
        this.globalIdx = -1;
        this.appendTapeFrame(this.siblingPath(0)!);
        this.ensureTapeAhead(); // 新容器窄帧时同样要扩带，滚动空间才接得上
        void this.preloadAhead(1);
        return;
      }
      // 非拼接：单帧切换
      this.ctx.siblings = imgs;
      this.ctx.path = imgs[0];
      app.toast(`切换到「${baseName(imgs[0])}」`);
      await this.renderWindow(0);
    } finally {
      this.advancing = false;
      this.syncButtons();
    }
  }

  /** 后退一张：容器内还有上一张就翻上一张，
   *  已是容器第一张时跳同级上一个目录 / zip 文件的最后一张 */
  private async retreat(): Promise<void> {
    if (!this.ctx || this.advancing) return;
    if (this.globalIdx > 0) {
      this.advancing = true;
      try {
        await this.goTo(this.globalIdx - 1);
      } finally {
        this.advancing = false;
        this.syncButtons();
      }
      return;
    }
    this.advancing = true;
    try {
      // 容器内已是第一张：跨到上一个有图的容器的最后一张
      const wasPlaying = this.slideOn || this.scrollOn; // 等待前的播放意图
      const imgs = await this.prevContainerWithImages();
      if (!this.ctx) return; // 等待期间视图已关闭：放弃过期切换
      if (!imgs) {
        if (wasPlaying) this.stopPlayback(); // 已是起点：停掉定时器并同步宿主按钮状态
        app.toast("已经是第一张：前面没有更多图片了");
        return;
      }
      if (wasPlaying && !this.slideOn && !this.scrollOn) return; // 等待期间播放已被停止：放弃过期切换
      this.ctx.siblings = imgs;
      this.ctx.path = imgs[imgs.length - 1];
      app.toast(`切换到「${baseName(this.ctx.path)}」`);
      await this.renderWindow(imgs.length - 1);
    } finally {
      this.advancing = false;
      this.syncButtons();
    }
  }

  private async goTo(index: number): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.renderWindow(index);
    } catch (e) {
      app.showMessage("打开失败", String(e));
    }
    this.restartTimers();
  }

  private setSlideshow(on: boolean): void {
    this.slideOn = on;
    if (on) {
      playMode = "slide";
      saveSetting("playMode", "slide");
      this.scrollOn = false;
      this.stopTimers();
      this.slideTimer = window.setInterval(() => void this.advance(), Math.max(1, slideSeconds) * 1000);
    } else {
      clearInterval(this.slideTimer); // 停止时必须清掉定时器，否则播放继续
      this.slideTimer = 0;
    }
    this.syncButtons();
    app.toast(on ? `幻灯播放：每 ${slideSeconds} 秒一张` : "已停止幻灯播放");
  }

  private setAutoScroll(on: boolean): void {
    this.scrollOn = on;
    this.scrollSuspended = false;
    if (on) {
      playMode = "scroll";
      saveSetting("playMode", "scroll");
      this.slideOn = false;
      clearInterval(this.slideTimer);
      this.slideTimer = 0;
      // 拼接开启时先构建胶片带再启动循环，首个边界即无缝
      const start = async () => {
        if (stitch) await this.renderWindow(this.globalIdx);
        if (this.scrollOn) this.startScrollLoop();
      };
      void start();
    } else {
      this.stopScrollLoop();
    }
    this.syncButtons();
    app.toast(on ? `自动滚屏（${dirLabel(direction)}）：到底自动换下一张` : "已停止自动滚屏");
  }

  private stopPlayback(): void {
    this.slideOn = false;
    this.scrollOn = false;
    this.advancing = false;
    this.stopTimers();
    this.syncButtons();
  }

  /** 宿主「滚屏/播放」入口：播放中→全部停止；未播放→按上次选择的模式（滚屏/幻灯）开始 */
  togglePlay(): void {
    if (this.slideOn || this.scrollOn) {
      this.stopPlayback();
      app.toast("已停止播放");
      return;
    }
    if (playMode === "slide") this.setSlideshow(true);
    else this.setAutoScroll(true);
  }

  /** 宿主「上一个/下一个文件」入口：上一张/下一张（跨目录/压缩包接续由 advance/retreat 处理） */
  navFile(delta: number): void {
    if (delta > 0) void this.advance();
    else void this.retreat();
  }

  /** 仅激活 tab 的实例接收全局事件（当前无 window 级监听，滚轮挂在面板内随面板销毁）；存值备用 */
  setActive(on: boolean): void {
    this.activeVisible = on;
  }

  syncButtons(): void {
    const modeSel = this.q<HTMLSelectElement>(".imgv-playmode");
    if (modeSel) modeSel.value = playMode;
    // 只显示当前选中模式对应的设置项
    this.q<HTMLElement>(".imgv-set-scroll")?.classList.toggle("hidden", playMode !== "scroll");
    this.q<HTMLElement>(".imgv-set-slide")?.classList.toggle("hidden", playMode !== "slide");
    const sel = this.q<HTMLSelectElement>(".imgv-interval");
    if (sel) sel.value = String(slideSeconds);
    const speed = this.q<HTMLInputElement>(".imgv-speed");
    if (speed) speed.value = String(scrollPxPerSec);
    const dir = this.q<HTMLSelectElement>(".imgv-dir");
    if (dir) dir.value = direction;
    this.ctx?.setKeepAwake(this.slideOn || this.scrollOn); // 幻灯或自动滚屏任一播放中 → 常亮（幂等）
    this.syncStatus(); // 幻灯/滚屏/方向等播放状态变化 → 状态栏"显示"格随之更新
  }

  /* ========== 方向/拼接设置（菜单与面板控件共用；模块级偏好 + 本实例视图同步） ========== */

  setDirection(d: Direction): void {
    direction = d;
    saveSetting("direction", d);
    this.syncButtons();
    void this.renderWindow(this.globalIdx); // 始终按新方向重建（滚屏中则带窗口滑动）
  }

  setStitch(on: boolean): void {
    stitch = on;
    saveSetting("stitch", on);
    void this.renderWindow(this.globalIdx);
  }

  /** 菜单改幻灯间隔后的同步（无存活实例时 menu 侧跳过，等同旧版 ctx 为 null 的空转） */
  applySlideSeconds(): void {
    if (this.slideOn) this.restartTimers();
    this.syncButtons();
  }

  /* ========== 视图构建 ========== */

  private buildView(): void {
    const c = this.ctx;
    if (!c) return;
    c.host.innerHTML = `
    <div class="imgv">
      <div class="imgv-bar plugin-topbar">
        <span class="imgv-name"></span>
        <span class="imgv-page"></span>
        <span class="imgv-spacer"></span>
        <span class="imgv-zoom"></span>
        <button data-act="prev" title="上一张">◀</button>
        <button data-act="next" title="下一张">▶</button>
        <button data-act="zoomin" title="放大">＋</button>
        <button data-act="zoomout" title="缩小">－</button>
        <button data-act="fitmenu" title="缩放模式">适应窗口</button>
        <button data-act="rotate" title="旋转 90°">↻</button>
        <span class="imgv-sep"></span>
        <select class="imgv-playmode" title="播放模式：选中后显示对应设置项；开始/停止用全局播放按钮（Space）">
          <option value="scroll">滚屏</option>
          <option value="slide">幻灯</option>
        </select>
        <span class="imgv-playset imgv-set-scroll">
          <select class="imgv-dir" title="滚屏方向">
            <option value="down">向下</option>
            <option value="ltr">向右</option>
            <option value="rtl">向左</option>
          </select>
          <input class="imgv-speed" type="number" min="20" max="2000" step="20" value="100"
            title="滚屏速度（像素/秒，20–2000）" />
        </span>
        <span class="imgv-playset imgv-set-slide">
          <select class="imgv-interval" title="幻灯间隔（秒）">
            <option value="2">2秒</option>
            <option value="3">3秒</option>
            <option value="5">5秒</option>
            <option value="10">10秒</option>
            <option value="30">30秒</option>
          </select>
        </span>
        <button data-act="close" title="关闭图片，回到文本">✕</button>
      </div>
      <div class="imgv-stage">
        <div class="imgv-strip dir-down"></div>
      </div>
    </div>`;

    c.host.querySelector(".imgv-bar")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
      if (!btn) return;
      switch (btn.dataset.act) {
        case "prev":
          void this.retreat();
          break;
        case "next":
          void this.advance();
          break;
        case "zoomin": this.zoomAt(1.25, this.stageCenter().x, this.stageCenter().y); break;
        case "zoomout": this.zoomAt(1 / 1.25, this.stageCenter().x, this.stageCenter().y); break;
        case "fitmenu": this.showFitMenu(btn); break;
        case "rotate":
          this.rotation = (this.rotation + 90) % 360;
          this.applyLayout();
          break;
        case "close": this.ctx?.closeView(); break;
      }
    });

    c.host.querySelector(".imgv-playmode")?.addEventListener("change", (e) => {
      const mode = (e.target as HTMLSelectElement).value as "scroll" | "slide";
      if (mode === playMode) return;
      if (this.slideOn || this.scrollOn) {
        // 播放中切换模式：直接切到新模式继续播（set* 内部会停掉旧模式并记录 playMode）
        if (mode === "slide") this.setSlideshow(true);
        else this.setAutoScroll(true);
      } else {
        playMode = mode;
        saveSetting("playMode", mode);
        this.syncButtons();
      }
    });

    c.host.querySelector(".imgv-interval")?.addEventListener("change", (e) => {
      slideSeconds = Number((e.target as HTMLSelectElement).value) || 5;
      saveSetting("slideSeconds", slideSeconds);
      if (this.slideOn) this.restartTimers();
    });

    c.host.querySelector(".imgv-dir")?.addEventListener("change", (e) => {
      this.setDirection((e.target as HTMLSelectElement).value as Direction);
    });

    c.host.querySelector(".imgv-speed")?.addEventListener("change", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      scrollPxPerSec = Math.min(2000, Math.max(20, Number.isFinite(v) && v > 0 ? v : 100));
      saveSetting("scrollPxPerSec", scrollPxPerSec);
      (e.target as HTMLInputElement).value = String(scrollPxPerSec);
    });

    const stage = c.host.querySelector(".imgv-stage") as HTMLElement;
    stage.addEventListener("wheel", (e) => {
      if (this.scrollOn) {
        this.scrollSuspended = true; // 用户手动操作时暂停自动滚屏，停止操作 2 秒后恢复
        this.suspendedAt = performance.now();
      }
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      this.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    window.addEventListener("resize", this.onResizeHandler);
    this.syncButtons(); // 控件初始值与当前设置同步
  }

  private stageCenter(): { x: number; y: number } {
    const stage = this.q<HTMLElement>(".imgv-stage");
    if (!stage) return { x: 0, y: 0 };
    return { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
  }

  private onResize(): void {
    if (this.ctx && this.fitMode !== "custom") this.applyLayout();
  }

  /* ========== 实例生命周期 ========== */

  open(c: PluginOpenContext): void {
    this.ctx = c;
    this.viewId = c.viewId;
    this.globalIdx = Math.max(0, Math.min(c.siblingIndex, c.siblings.length - 1));
    this.buildView();
    void this.renderWindow(this.globalIdx);
  }

  deactivate(): void {
    window.removeEventListener("resize", this.onResizeHandler);
    this.stopPlayback(); // 停止播放（幻灯定时器/滚屏 raf 全清）并释放常亮
    this.layoutRetry = 0;
    for (const u of this.urlCache.values()) URL.revokeObjectURL(u);
    this.urlCache.clear();
    this.urlInflight.clear();
    this.preloadInflight.clear();
    this.tape = [];
    this.tapeCur = 0;
    this.ctx = null; // 共享的 dimCache/listCache 保留（纯内容派生，跨实例命中是收益）
  }
}

/* ========== 插件固定设置菜单（层级子菜单；外层"图片查看"由注册表包装） ========== */

function menu(): MenuItemDef[] {
  return [
    {
      label: "滚动方向",
      children: () => [
        {
          label: "从上向下",
          checked: () => direction === "down",
          action: () => {
            direction = "down";
            saveSetting("direction", "down");
            liveView()?.setDirection("down");
          },
        },
        {
          label: "从左至右",
          checked: () => direction === "ltr",
          action: () => {
            direction = "ltr";
            saveSetting("direction", "ltr");
            liveView()?.setDirection("ltr");
          },
        },
        {
          label: "从右至左",
          checked: () => direction === "rtl",
          action: () => {
            direction = "rtl";
            saveSetting("direction", "rtl");
            liveView()?.setDirection("rtl");
          },
        },
      ],
    },
    {
      label: "滚屏无缝拼接下一张",
      checked: () => stitch,
      action: () => {
        stitch = !stitch;
        saveSetting("stitch", stitch);
        liveView()?.setStitch(stitch);
      },
    },
    {
      label: "幻灯间隔",
      children: () =>
        [2, 3, 5, 10, 30].map((s) => ({
          label: `${s} 秒`,
          checked: () => slideSeconds === s,
          action: () => {
            slideSeconds = s;
            saveSetting("slideSeconds", s);
            liveView()?.applySlideSeconds();
          },
        })),
    },
    {
      label: "滚屏速度",
      children: () =>
        [50, 100, 200, 400, 800].map((v) => ({
          label: `${v} 像素/秒`,
          checked: () => scrollPxPerSec === v,
          action: () => {
            scrollPxPerSec = v;
            saveSetting("scrollPxPerSec", v);
            liveView()?.syncButtons();
          },
        })),
    },
  ];
}

/* ========== 插件定义 ========== */

export const imageViewerPlugin: ReadBookPlugin = {
  id: PID,
  name: "图片查看",
  version: "1.7.0",
  description:
    "查看常见图片格式：缩放（滚轮以鼠标为焦点）/旋转/缩放模式下拉（适应窗口·适宽·适高·原始大小）；播放模式下拉（滚屏/幻灯，选中显示对应设置项）：滚屏向下/向右/向左无缝拼接预加载，幻灯按间隔自动换张，跨目录与跨压缩包接续；支持多标签页多实例",
  extensions: EXTENSIONS,
  menu,
  createView: () => new ImageView(),
};
