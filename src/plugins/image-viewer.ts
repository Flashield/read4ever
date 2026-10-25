/* 图片查看插件：查看常见图片格式（含 zip 内图片）。
   支持：缩放（滚轮以鼠标为焦点）/旋转/适应窗口·适宽·适高/幻灯播放/
   自动滚屏（向下·向右·向左，无缝拼接预加载，跨目录与跨压缩包接续）。 */
import { api } from "../api";
import * as app from "../app";
import { deactivateActive, pluginSetting, setPluginSetting } from "./registry";
import type { MenuItemDef } from "../dropdown";
import type { PluginOpenContext, ReadBookPlugin } from "./types";

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

/* 固定设置（持久化于 settings.pluginSettings） */
let direction: Direction = pluginSetting<Direction>(PID, "direction", "down");
let stitch = pluginSetting<boolean>(PID, "stitch", true);
let slideSeconds = pluginSetting<number>(PID, "slideSeconds", 5);
let scrollPxPerSec = pluginSetting<number>(PID, "scrollPxPerSec", 100);

function saveSetting(key: string, val: string | number | boolean): void {
  setPluginSetting(PID, key, val);
}

/* 视图状态 */
let ctx: PluginOpenContext | null = null;
let fitMode: FitMode = "contain";
let zoom = 1; // fitMode === "custom" 时生效
let rotation = 0; // 仅作用于当前帧
let globalIdx = 0; // 当前图在 ctx.siblings 中的下标
let advancing = false;
let bottomSince = 0;

/* 播放状态 */
let slideTimer = 0;
let slideOn = false;
let scrollOn = false;
let scrollSuspended = false;
let scrollRaf = 0; // rAF 循环 id
let scrollFallback = 0; // rAF 停摆时的兜底定时器 id
let lastFrameTs = 0;

/* 胶片带：观看顺序窗口（上一张/当前/下一张），DOM 顺序在 rtl 下反转。
   每帧按自身展示要求（适应窗口/适宽/适高/自定义）独立计算倍率。 */
interface TapeItem {
  path: string;
  url: string;
  w: number;
  h: number;
  ratio: number;
  el: HTMLElement;
}
let tape: TapeItem[] = [];
let tapeCur = 0; // 当前图在 tape 中的下标

const urlCache = new Map<string, string>();
const dimCache = new Map<string, { w: number; h: number }>();
const listCache = new Map<string, string[]>(); // 容器 → 图片路径列表
const TAPE_GAP = 16; // 与 .imgv-strip 的 gap 保持一致（滚动补偿用）

const q = <T extends Element>(sel: string): T | null =>
  ctx ? (ctx.host.querySelector(sel) as T | null) : null;

const extMime = (name: string): string => {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && MIME[m[0]]) || "application/octet-stream";
};
const baseName = (p: string): string => p.split(/[\\/:]+/).filter(Boolean).pop() || p;
const parentOf = (p: string): string => {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
};

/* ========== 字节 / URL / 尺寸缓存 ========== */

async function loadBytes(path: string): Promise<Uint8Array> {
  const m = path.match(/^(.+\.zip)::(.+)$/i);
  const buf = m ? await api.readZipBytes(m[1], m[2]) : await api.readFileBytes(path);
  return new Uint8Array(buf);
}

async function ensureUrl(path: string): Promise<string> {
  const hit = urlCache.get(path);
  if (hit) return hit;
  const bytes = await loadBytes(path);
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: extMime(path) });
  const url = URL.createObjectURL(blob);
  urlCache.set(path, url);
  if (urlCache.size > 8) {
    const oldest = urlCache.keys().next().value as string;
    const u = urlCache.get(oldest);
    urlCache.delete(oldest);
    if (u) URL.revokeObjectURL(u);
  }
  return url;
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
  const hit = listCache.get(c.path);
  if (hit) return hit;
  let out: string[] = [];
  try {
    if (c.type === "zip") {
      const all = await api.listZip(c.path);
      out = all
        .filter((n) => IMAGE_RE.test(n))
        .sort((a, b) => a.localeCompare(b, "zh"))
        .map((n) => `${c.path}::${n}`);
    } else {
      const entries = await api.listDir(c.path);
      out = entries
        .filter((e) => !e.isDir && IMAGE_RE.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"))
        .map((e) => e.path);
    }
  } catch {
    out = [];
  }
  listCache.set(c.path, out);
  return out;
}

/** 播完当前容器后，取同级的下一个容器（list_dir 顺序：目录在前，zip 文件随后） */
async function nextContainer(c: Container): Promise<Container | null> {
  try {
    const entries = await api.listDir(parentOf(c.path));
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
    const entries = await api.listDir(parentOf(c.path));
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

const siblingPath = (i: number): string | null =>
  ctx && i >= 0 && i < ctx.siblings.length ? ctx.siblings[i] : null;

/* ========== 视图渲染 ========== */

function frameEl(url: string): { el: HTMLElement; img: HTMLImageElement } {
  const el = document.createElement("div");
  el.className = "imgv-frame";
  const img = document.createElement("img");
  img.className = "imgv-img";
  img.src = url;
  el.appendChild(img);
  return { el, img };
}

/** 重建视图：以 globalIdx 为当前帧；拼接+滚屏时窗口三帧（预加载下一张），否则单帧 */
async function renderWindow(g: number): Promise<void> {
  if (!ctx) return;
  globalIdx = Math.max(0, Math.min(g, ctx.siblings.length - 1));
  const useTape = stitch && scrollOn;
  const paths: string[] = useTape
    ? [siblingPath(globalIdx - 1), siblingPath(globalIdx), siblingPath(globalIdx + 1)].filter(
        (p): p is string => !!p
      )
    : [ctx.siblings[globalIdx]];

  const urls = await Promise.all(paths.map((p) => ensureUrl(p)));
  const dims: { w: number; h: number }[] = [];
  for (let i = 0; i < paths.length; i++) {
    const hit = dimCache.get(paths[i]);
    dims.push(hit ?? (await ensureDims(paths[i], urls[i])));
    dimCache.set(paths[i], dims[i]);
  }

  // DOM 顺序：rtl 时观看顺序反转（首张在最右）
  const order = direction === "rtl" ? [...paths.keys()].reverse() : [...paths.keys()];
  const strip = q<HTMLElement>(".imgv-strip")!;
  strip.innerHTML = "";
  strip.className = `imgv-strip dir-${direction}`;
  tape = [];
  let curDom = 0;
  order.forEach((k, domIdx) => {
    const fe = frameEl(urls[k]);
    strip.appendChild(fe.el);
    tape.push({ path: paths[k], url: urls[k], w: dims[k].w, h: dims[k].h, ratio: 1, el: fe.el });
    if (paths[k] === ctx!.siblings[globalIdx]) curDom = domIdx;
  });
  tapeCur = curDom;

  applyLayout();
  alignCurrent();
  updateLabels();
  // 预解码各帧 + 预加载后续帧（拼接滚动无缝的关键）；单帧模式预载前后一张，幻灯/翻页零等待
  for (const item of tape) {
    (item.el.querySelector(".imgv-img") as HTMLImageElement | null)?.decode?.().catch(() => {});
  }
  if (useTape) void preloadAhead(globalIdx + 2);
  else {
    void preloadAhead(globalIdx + 1);
    void preloadAhead(globalIdx - 1);
  }
}

function alignCurrent(): void {
  const stage = q<HTMLElement>(".imgv-stage");
  const cur = tape[tapeCur];
  if (!stage || !cur) return;
  const sr = stage.getBoundingClientRect();
  const fr = cur.el.getBoundingClientRect();
  if (direction === "down") stage.scrollTop += fr.top - sr.top;
  else if (direction === "ltr") stage.scrollLeft += fr.left - sr.left;
  else stage.scrollLeft += fr.right - sr.right;
}

/** 摘除观看顺序最前的帧（含各方向的滚动位置补偿） */
function dropTapeHead(): void {
  const dropped = tape.shift()!;
  tapeCur = Math.max(0, tapeCur - 1);
  const stage = q<HTMLElement>(".imgv-stage")!;
  if (direction === "down") stage.scrollTop -= dropped.el.offsetHeight + TAPE_GAP;
  else if (direction === "ltr") stage.scrollLeft -= dropped.el.offsetWidth + TAPE_GAP;
  else dropped.el.remove(); // rtl：尾帧移除不影响左侧视口
  if (direction !== "rtl") dropped.el.remove();
}

/** 追加一帧到胶片带尾部（url/尺寸应已预加载缓存；未就绪时后台补齐后再追加） */
function appendTapeFrame(path: string): void {
  if (!ctx || tape.some((t) => t.path === path)) return;
  const url = urlCache.get(path);
  const dims = dimCache.get(path);
  if (!url || !dims) {
    void (async () => {
      try {
        const u = await ensureUrl(path);
        const d = await ensureDims(path, u);
        appendTapeFrameReady(path, u, d);
      } catch {
        /* 加载失败忽略 */
      }
    })();
    return;
  }
  appendTapeFrameReady(path, url, dims);
}

function appendTapeFrameReady(path: string, url: string, d: { w: number; h: number }): void {
  if (!ctx || tape.some((t) => t.path === path)) return;
  const fe = frameEl(url);
  const item: TapeItem = { path, url, w: d.w, h: d.h, ratio: 1, el: fe.el };
  const strip = q<HTMLElement>(".imgv-strip")!;
  if (direction === "rtl") {
    strip.insertBefore(fe.el, strip.firstChild);
    tape.unshift(item);
  } else {
    strip.appendChild(fe.el);
    tape.push(item);
  }
  applyLayout();
  if (direction === "rtl") {
    // 左侧追加使内容整体右移：补偿滚动位置
    const stage = q<HTMLElement>(".imgv-stage")!;
    stage.scrollLeft += fe.el.offsetWidth + TAPE_GAP;
  }
  fe.img.decode?.().catch(() => {});
}

/** 拼接滚屏：滚过边界增量推进——当前帧元素不动，仅摘除滚出帧、追加预加载帧。
 *  全程同步无网络等待，边界无卡顿。 */
function promoteStep(): void {
  if (!ctx || !siblingPath(globalIdx + 1)) return;
  const nextPath = siblingPath(globalIdx + 1);
  // 下一帧尚未进带（字节仍在后台补）：先补齐，就绪后由滚动循环再次推进
  if (nextPath && !tape.some((t) => t.path === nextPath)) {
    appendTapeFrame(nextPath);
    return;
  }
  globalIdx++;
  tapeCur++;
  // 追加新的下一帧（预加载缓存命中时同步完成）
  const p = siblingPath(globalIdx + 1);
  if (p) appendTapeFrame(p);
  // 摘除完全滚出的头部帧（保留当前帧前最多 1 张）并补偿滚动位置
  while (tapeCur > 1) dropTapeHead();
  updateLabels();
  void preloadAhead(globalIdx + 2);
  syncButtons();
}

function updateLabels(): void {
  if (!ctx) return;
  const path = ctx.siblings[globalIdx];
  const nameEl = q<HTMLElement>(".imgv-name");
  if (nameEl) {
    nameEl.textContent = baseName(path);
    nameEl.title = path;
  }
  const pageEl = q<HTMLElement>(".imgv-page");
  if (pageEl) pageEl.textContent = ctx.siblings.length > 1 ? `${globalIdx + 1}/${ctx.siblings.length}` : "";
  api.setTitle(`ReadBook - ${baseName(path)}（图片）`);
}

let preheatedFor: string | null = null; // 已为其预热"下一容器"的容器路径

/** 播放接近容器末尾时，后台预热下一个容器（图片列表 + 首图字节/解码），
 *  跨容器切换零等待 */
function preheatNextContainer(): void {
  if (!ctx) return;
  const cur = containerOf(ctx.path);
  if (preheatedFor === cur.path) return;
  preheatedFor = cur.path;
  void (async () => {
    try {
      const nxt = await nextContainer(cur);
      if (!nxt) return;
      const imgs = await listImages(nxt);
      const first = imgs[0];
      if (!first) return;
      const url = await ensureUrl(first);
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => {});
      dimCache.set(first, { w: img.naturalWidth || 600, h: img.naturalHeight || 400 });
    } catch {
      /* 预热失败忽略，切换时按原路径加载 */
    }
  })();
}

const preloadInflight = new Set<string>();

/** 预加载：字节 → URL → 尺寸 → 解码，全部进缓存（滚动跨图无缝的关键）。
 *  幂等：已就绪或正在加载的直接跳过，滚动循环里可放心高频调用。 */
async function preloadAhead(index: number): Promise<void> {
  const p = siblingPath(index);
  if (!p || preloadInflight.has(p)) return;
  if (urlCache.has(p) && dimCache.has(p)) return;
  preloadInflight.add(p);
  try {
    const url = await ensureUrl(p);
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {}); // 预解码：进入视口时首帧直接绘制
    dimCache.set(p, { w: img.naturalWidth || 600, h: img.naturalHeight || 400 });
  } catch {
    /* 预加载失败忽略，滚到时再试 */
  } finally {
    preloadInflight.delete(p);
  }
}

let layoutRetry = 0;

function applyLayout(): void {
  if (!ctx) return;
  const stage = q<HTMLElement>(".imgv-stage");
  const cur = tape[tapeCur];
  const zoomEl = q<HTMLElement>(".imgv-zoom");
  if (!stage || !cur || !zoomEl) return;

  // 宿主短暂不可见/布局未就绪时 stage 尺寸会塌缩：延迟重试，避免把图片缩到地板尺寸
  if (stage.clientWidth < 80 && layoutRetry < 40) {
    layoutRetry++;
    setTimeout(() => applyLayout(), 16);
    return;
  }
  layoutRetry = 0;

  const availW = Math.max(40, stage.clientWidth - 24);
  const availH = Math.max(40, stage.clientHeight - 24);

  const ratioFor = (item: TapeItem, rot: number): number => {
    const s = rot % 180 !== 0;
    const visW = s ? item.h : item.w;
    const visH = s ? item.w : item.h;
    let r: number;
    if (fitMode === "contain") r = Math.min(availW / visW, availH / visH);
    else if (fitMode === "width") r = availW / visW;
    else if (fitMode === "height") r = availH / visH;
    else r = zoom;
    return Math.min(20, Math.max(0.02, r));
  };

  // 每帧按自身展示要求独立计算倍率（当前帧决定整体缩放基准），仍是互相独立的图片
  for (const item of tape) {
    const isCur = item === cur;
    const rot = isCur ? rotation : 0;
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
  layoutRetry = 0;
  syncModeButtons();
}

function syncModeButtons(): void {
  const map: Record<FitMode, string> = { contain: "fit", width: "fitw", height: "fith", custom: "" };
  const act = map[fitMode];
  // 只调整三个适应模式按钮——幻灯/滚屏按钮的状态由 syncButtons 管理，不能误清
  for (const a of ["fit", "fitw", "fith"]) {
    q<HTMLElement>(`button[data-act="${a}"]`)?.classList.toggle("active", a === act);
  }
}

function setFit(mode: FitMode): void {
  fitMode = mode;
  applyLayout();
}

/* ========== 焦点缩放 ========== */

/** 以 (px,py)（相对 stage 视口）为焦点缩放，光标下的内容点保持不动。
 *  缩放围绕帧中心发生：点' = 中心new + (点 - 中心old) × f。 */
function zoomAt(factor: number, px: number, py: number): void {
  const stage = q<HTMLElement>(".imgv-stage");
  const frame = tape[tapeCur]?.el ?? q<HTMLElement>(".imgv-frame");
  if (!stage || !frame) return;
  fitMode = "custom";
  const oldW = frame.getBoundingClientRect().width;
  const oldH = frame.getBoundingClientRect().height;
  const bx = stage.scrollLeft + px; // 光标处的内容坐标（视觉空间）
  const by = stage.scrollTop + py;
  zoom = Math.min(20, Math.max(0.02, zoom * factor));
  applyLayout();
  const newW = frame.getBoundingClientRect().width;
  const newH = frame.getBoundingClientRect().height;
  const f = newW / oldW;
  stage.scrollLeft = Math.max(0, newW / 2 + (bx - oldW / 2) * f - px);
  stage.scrollTop = Math.max(0, newH / 2 + (by - oldH / 2) * f - py);
}

/* ========== 播放：幻灯 + 自动滚屏 ========== */

function stopScrollLoop(): void {
  cancelAnimationFrame(scrollRaf);
  clearInterval(scrollFallback);
  scrollRaf = 0;
  scrollFallback = 0;
}

function stopTimers(): void {
  clearInterval(slideTimer);
  slideTimer = 0;
  stopScrollLoop();
}

function startScrollLoop(): void {
  stopScrollLoop();
  const stage = q<HTMLElement>(".imgv-stage");
  if (!stage) return;
  bottomSince = 0;
  let last = performance.now();
  lastFrameTs = last;

  const step = (now: number, dt: number): void => {
    if (scrollSuspended) return;
    const noOverflowY = stage.scrollHeight <= stage.clientHeight + 2;
    const noOverflowX = stage.scrollWidth <= stage.clientWidth + 2;
    const noOverflow = direction === "down" ? noOverflowY : noOverflowX;
    const atEnd =
      direction === "down"
        ? noOverflowY || stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
        : direction === "ltr"
          ? noOverflowX || stage.scrollLeft + stage.clientWidth >= stage.scrollWidth - 2
          : noOverflowX || stage.scrollLeft <= 2;
    // 拼接模式：滚过边界增量推进——当前帧元素不动，仅摘除滚出帧、追加预加载帧。
    // 下一帧顶边到达视口顶边（帧高大于视口）即推进；帧高≤视口时（适高/适应窗口）
    // 顶边到不了顶边，滚动到底而下一帧仍在带中就立即推进。两种情况都不停留。
    if (stitch) {
      const next = tape[tapeCur + 1];
      if (next) {
        const sr = stage.getBoundingClientRect();
        const r = next.el.getBoundingClientRect();
        const enter =
          direction === "down"
            ? r.top - sr.top <= 0
            : direction === "ltr"
              ? r.left - sr.left <= 0
              : r.right - sr.left <= stage.clientWidth;
        // 下一帧顶边开始进入视口就预热下下张：比边界推进再早一屏启动加载（幂等，已缓存自动跳过）
        const entering =
          direction === "down"
            ? r.top - sr.top <= stage.clientHeight
            : direction === "ltr"
              ? r.left - sr.left <= stage.clientWidth
              : r.right - sr.left >= 0;
        if (entering) void preloadAhead(globalIdx + 2);
        if (enter || (atEnd && !noOverflow)) {
          promoteStep();
          return;
        }
      }
    }
    // 图片装得下（无溢出）或真正到底/到边且后面已无帧：停留 1.5 秒再换，避免瞬间连跳
    if (atEnd) {
      preheatNextContainer(); // 幂等：接近容器末尾时后台预热下一个容器
      if (!bottomSince) bottomSince = now;
      if (now - bottomSince >= 1500) {
        bottomSince = 0;
        void advance();
        return;
      }
      return;
    }
    bottomSince = 0;
    if (direction === "down") stage.scrollTop += (scrollPxPerSec * dt) / 1000;
    else if (direction === "ltr") stage.scrollLeft += (scrollPxPerSec * dt) / 1000;
    else stage.scrollLeft -= (scrollPxPerSec * dt) / 1000;
  };

  // rAF 主循环：60fps 逐帧推进，滚动平滑
  const tick = (ts: number) => {
    if (!scrollOn || !ctx) {
      stopScrollLoop();
      return;
    }
    if (advancing) {
      lastFrameTs = ts;
      last = ts;
      scrollRaf = requestAnimationFrame(tick); // 换图进行中，保持循环等待
      return;
    }
    const dt = Math.min(100, ts - last);
    last = ts;
    lastFrameTs = ts;
    step(ts, dt);
    scrollRaf = requestAnimationFrame(tick);
  };
  scrollRaf = requestAnimationFrame(tick);

  // 看门狗：rAF 停摆（窗口被遮挡/后台标签）时以 10Hz 兜底推进，保证功能不中断
  scrollFallback = window.setInterval(() => {
    if (!scrollOn || !ctx) {
      stopScrollLoop();
      return;
    }
    const now = performance.now();
    if (advancing || now - lastFrameTs < 400) return; // rAF 正常工作时跳过
    const dt = Math.min(400, now - last);
    last = now;
    lastFrameTs = now;
    step(now, dt);
  }, 100);
}

function restartTimers(): void {
  if (slideOn) {
    clearInterval(slideTimer);
    slideTimer = window.setInterval(() => void advance(), Math.max(1, slideSeconds) * 1000);
  }
  if (scrollOn) {
    scrollSuspended = false;
    startScrollLoop();
  }
  syncButtons();
}

/** 找同级的下一个有图片的容器（跳过空容器，防环，最多找 200 个） */
async function nextContainerWithImages(): Promise<string[] | null> {
  if (!ctx) return null;
  const visited = new Set<string>([containerOf(ctx.path).path]);
  let c: Container | null = containerOf(ctx.path);
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
async function prevContainerWithImages(): Promise<string[] | null> {
  if (!ctx) return null;
  const visited = new Set<string>([containerOf(ctx.path).path]);
  let c: Container | null = containerOf(ctx.path);
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
async function advance(): Promise<void> {
  if (!ctx || advancing) return;
  if (siblingPath(globalIdx + 1)) {
    // 拼接滚屏中：同容器内增量推进（无重绘无等待，边界无卡顿）
    if (stitch && scrollOn) {
      promoteStep();
      return;
    }
    advancing = true;
    try {
      await goTo(globalIdx + 1);
    } finally {
      advancing = false;
      syncButtons();
    }
    return;
  }
  advancing = true;
  try {
    // 容器已到最后一张：跨容器接续（找下一个有图的容器，预热缓存命中 → 即时）
    const imgs = await nextContainerWithImages();
    if (!imgs) {
      app.toast("播放结束：后面没有更多图片了");
      return;
    }
    if (stitch && scrollOn) {
      // 拼接滚屏：增量衔接——当前帧元素不动，摘除旧容器帧（视口已不含它们），追加新容器首帧
      ctx.siblings = imgs;
      ctx.path = imgs[0];
      globalIdx = 0;
      while (tapeCur > 0) dropTapeHead();
      appendTapeFrame(siblingPath(0)!);
      updateLabels();
      void preloadAhead(1);
      return;
    }
    // 非拼接：单帧切换
    ctx.siblings = imgs;
    ctx.path = imgs[0];
    app.toast(`切换到「${baseName(imgs[0])}」`);
    await renderWindow(0);
  } finally {
    advancing = false;
    syncButtons();
  }
}

/** 后退一张：容器内还有上一张就翻上一张，
 *  已是容器第一张时跳同级上一个目录 / zip 文件的最后一张 */
async function retreat(): Promise<void> {
  if (!ctx || advancing) return;
  if (globalIdx > 0) {
    advancing = true;
    try {
      await goTo(globalIdx - 1);
    } finally {
      advancing = false;
      syncButtons();
    }
    return;
  }
  advancing = true;
  try {
    // 容器内已是第一张：跨到上一个有图的容器的最后一张
    const imgs = await prevContainerWithImages();
    if (!imgs) {
      app.toast("已经是第一张：前面没有更多图片了");
      return;
    }
    ctx.siblings = imgs;
    ctx.path = imgs[imgs.length - 1];
    app.toast(`切换到「${baseName(ctx.path)}」`);
    await renderWindow(imgs.length - 1);
  } finally {
    advancing = false;
    syncButtons();
  }
}

async function goTo(index: number): Promise<void> {
  if (!ctx) return;
  try {
    await renderWindow(index);
  } catch (e) {
    app.showMessage("打开失败", String(e));
  }
  restartTimers();
}

function setSlideshow(on: boolean): void {
  slideOn = on;
  if (on) {
    scrollOn = false;
    stopTimers();
    slideTimer = window.setInterval(() => void advance(), Math.max(1, slideSeconds) * 1000);
  } else {
    clearInterval(slideTimer); // 停止时必须清掉定时器，否则播放继续
    slideTimer = 0;
  }
  syncButtons();
  app.toast(on ? `幻灯播放：每 ${slideSeconds} 秒一张` : "已停止幻灯播放");
}

function setAutoScroll(on: boolean): void {
  scrollOn = on;
  scrollSuspended = false;
  if (on) {
    slideOn = false;
    clearInterval(slideTimer);
    slideTimer = 0;
    // 拼接开启时先构建胶片带再启动循环，首个边界即无缝
    const start = async () => {
      if (stitch) await renderWindow(globalIdx);
      if (scrollOn) startScrollLoop();
    };
    void start();
  } else {
    stopScrollLoop();
  }
  syncButtons();
  app.toast(on ? `自动滚屏（${dirLabel(direction)}）：到底自动换下一张` : "已停止自动滚屏");
}

function stopPlayback(): void {
  slideOn = false;
  scrollOn = false;
  advancing = false;
  stopTimers();
  syncButtons();
}

function syncButtons(): void {
  q<HTMLElement>(`button[data-act="slide"]`)?.classList.toggle("active", slideOn);
  q<HTMLElement>(`button[data-act="autoscroll"]`)?.classList.toggle("active", scrollOn);
  const sel = q<HTMLSelectElement>(".imgv-interval");
  if (sel) sel.value = String(slideSeconds);
  const speed = q<HTMLInputElement>(".imgv-speed");
  if (speed) speed.value = String(scrollPxPerSec);
  const dir = q<HTMLSelectElement>(".imgv-dir");
  if (dir) dir.value = direction;
}

const dirLabel = (d: Direction): string =>
  d === "down" ? "从上向下" : d === "ltr" ? "从左至右" : "从右至左";

function setDirection(d: Direction): void {
  direction = d;
  saveSetting("direction", d);
  syncButtons();
  void renderWindow(globalIdx); // 始终按新方向重建（滚屏中则带窗口滑动）
}

function setStitch(on: boolean): void {
  stitch = on;
  saveSetting("stitch", on);
  void renderWindow(globalIdx);
}

/* ========== 插件固定设置菜单（层级子菜单；外层"图片查看"由注册表包装） ========== */

function menu(): MenuItemDef[] {
  return [
    {
      label: "滚动方向",
      children: () => [
        { label: "从上向下", checked: () => direction === "down", action: () => setDirection("down") },
        { label: "从左至右", checked: () => direction === "ltr", action: () => setDirection("ltr") },
        { label: "从右至左", checked: () => direction === "rtl", action: () => setDirection("rtl") },
      ],
    },
    {
      label: "滚屏无缝拼接下一张",
      checked: () => stitch,
      action: () => setStitch(!stitch),
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
            if (slideOn) restartTimers();
            syncButtons();
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
            syncButtons();
          },
        })),
    },
    { sep: true },
    {
      label: "打开插件管理…",
      action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "plugin-panel" })),
    },
  ];
}

/* ========== 视图构建 ========== */

function buildView(host: HTMLElement): void {
  host.innerHTML = `
    <div class="imgv">
      <div class="imgv-bar">
        <span class="imgv-name"></span>
        <span class="imgv-page"></span>
        <span class="imgv-spacer"></span>
        <span class="imgv-zoom"></span>
        <button data-act="prev" title="上一张">◀</button>
        <button data-act="next" title="下一张">▶</button>
        <button data-act="zoomin" title="放大">＋</button>
        <button data-act="zoomout" title="缩小">－</button>
        <button data-act="fit" title="适应窗口">适应窗口</button>
        <button data-act="fitw" title="适合宽度">适宽</button>
        <button data-act="fith" title="适合高度">适高</button>
        <button data-act="orig" title="原始大小 (100%)">1:1</button>
        <button data-act="rotate" title="旋转 90°">↻</button>
        <span class="imgv-sep"></span>
        <button data-act="slide" title="幻灯播放：按间隔自动换下一张，播完接续下一目录/压缩包">幻灯</button>
        <select class="imgv-interval" title="幻灯间隔（秒）">
          <option value="2">2秒</option>
          <option value="3">3秒</option>
          <option value="5" selected>5秒</option>
          <option value="10">10秒</option>
          <option value="30">30秒</option>
        </select>
        <select class="imgv-dir" title="滚屏方向">
          <option value="down">向下</option>
          <option value="ltr">向右</option>
          <option value="rtl">向左</option>
        </select>
        <input class="imgv-speed" type="number" min="20" max="2000" step="20" value="100"
          title="滚屏速度（像素/秒，20–2000）" />
        <button data-act="autoscroll" title="自动滚屏播放（无缝拼接可在插件菜单开启）">滚屏</button>
        <button data-act="close" title="关闭图片，回到文本">✕</button>
      </div>
      <div class="imgv-stage">
        <div class="imgv-strip dir-down"></div>
      </div>
    </div>`;

  host.querySelector(".imgv-bar")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
    if (!btn) return;
    switch (btn.dataset.act) {
      case "prev":
        void retreat();
        break;
      case "next":
        void advance();
        break;
      case "zoomin": zoomAt(1.25, stageCenter().x, stageCenter().y); break;
      case "zoomout": zoomAt(1 / 1.25, stageCenter().x, stageCenter().y); break;
      case "fit": setFit("contain"); break;
      case "fitw": setFit("width"); break;
      case "fith": setFit("height"); break;
      case "orig": fitMode = "custom"; zoom = 1; applyLayout(); break;
      case "rotate": rotation = (rotation + 90) % 360; applyLayout(); break;
      case "slide": setSlideshow(!slideOn); break;
      case "autoscroll": setAutoScroll(!scrollOn); break;
      case "close": deactivateActive(); break;
    }
  });

  host.querySelector(".imgv-interval")?.addEventListener("change", (e) => {
    slideSeconds = Number((e.target as HTMLSelectElement).value) || 5;
    saveSetting("slideSeconds", slideSeconds);
    if (slideOn) restartTimers();
  });

  host.querySelector(".imgv-dir")?.addEventListener("change", (e) => {
    setDirection((e.target as HTMLSelectElement).value as Direction);
  });

  host.querySelector(".imgv-speed")?.addEventListener("change", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    scrollPxPerSec = Math.min(2000, Math.max(20, Number.isFinite(v) && v > 0 ? v : 100));
    saveSetting("scrollPxPerSec", scrollPxPerSec);
    (e.target as HTMLInputElement).value = String(scrollPxPerSec);
  });

  const stage = host.querySelector(".imgv-stage") as HTMLElement;
  stage.addEventListener("wheel", (e) => {
    if (scrollOn) scrollSuspended = true; // 用户手动滚动时暂停自动滚屏，下一张恢复
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  window.addEventListener("resize", onResize);
  syncButtons(); // 控件初始值与当前设置同步
}

function stageCenter(): { x: number; y: number } {
  const stage = q<HTMLElement>(".imgv-stage");
  if (!stage) return { x: 0, y: 0 };
  return { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
}

function onResize(): void {
  if (ctx && fitMode !== "custom") applyLayout();
}

export const imageViewerPlugin: ReadBookPlugin = {
  id: PID,
  name: "图片查看",
  version: "1.3.1",
  description:
    "查看常见图片格式：缩放（滚轮以鼠标为焦点）/旋转/适应窗口·适宽·适高，幻灯播放，自动滚屏（向下/向右/向左，无缝拼接预加载，跨目录与跨压缩包接续）",
  extensions: EXTENSIONS,
  menu,
  open(c: PluginOpenContext): void {
    ctx = c;
    globalIdx = Math.max(0, Math.min(c.siblingIndex, c.siblings.length - 1));
    buildView(c.host);
    void renderWindow(globalIdx);
  },
  deactivate(): void {
    window.removeEventListener("resize", onResize);
    stopPlayback();
    layoutRetry = 0;
    for (const u of urlCache.values()) URL.revokeObjectURL(u);
    urlCache.clear();
    dimCache.clear();
    tape = [];
    ctx = null;
  },
};
