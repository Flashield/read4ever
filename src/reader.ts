/* 阅读区：内容渲染、连续滚屏引擎、页模式翻页、双页模式 */

export type ScrollMode = "continuous" | "page";

export interface ReaderHooks {
  /** 滚动位置变化（更新状态栏 / 保存进度） */
  onProgress: () => void;
  /** 滚动到文末（自动停止滚屏） */
  onPageEnd: () => void;
}

let hooks: ReaderHooks = { onProgress: () => {}, onPageEnd: () => {} };

let scrolling = false;
let mode: ScrollMode = "continuous";
let speed = 3; // 1..9 档
let pageInterval = 10; // 页模式间隔（秒）
let mouseFactor = 1; // 滚屏时鼠标纵向位置调速系数
let dual = false;

let rafId = 0;
let lastTs = 0;
let pageTimer = 0;
let cursorTimer = 0;

const el = () => document.getElementById("reader-content") as HTMLElement;

const WELCOME_HTML = `
<div class="welcome-screen">
  <h1>📖 ReadBook</h1>
  <p>文本阅读器 — 按 Ctrl+O 打开文件，或拖拽文件到窗口</p>
  <p class="welcome-tip">支持 TXT 文件和 ZIP 压缩包内的 TXT 文件</p>
</div>`;

export function init(h: ReaderHooks): void {
  hooks = h;
  el().addEventListener("scroll", () => hooks.onProgress());
  window.addEventListener("mousemove", onMouseMove);
}

/* 滚屏时鼠标位置控制速度：越靠下越快；移动鼠标时临时显示光标 */
function onMouseMove(e: MouseEvent): void {
  if (!scrolling) return;
  const y = Math.min(1, Math.max(0, e.clientY / window.innerHeight));
  mouseFactor = 0.2 + 2.8 * y;
  el().classList.remove("scroll-hidden");
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => {
    if (scrolling) el().classList.add("scroll-hidden");
  }, 1200);
}

/* ========== 内容 ========== */

export function setContent(text: string): void {
  const e = el();
  e.textContent = text;
  e.scrollTop = 0;
  e.scrollLeft = 0;
}

export function setContentHTML(html: string): void {
  const e = el();
  e.innerHTML = html;
}

export function showWelcome(): void {
  setContentHTML(WELCOME_HTML);
}

/* ========== 位置 ========== */

export function getRatio(): number {
  const e = el();
  if (dual) {
    const max = e.scrollWidth - e.clientWidth;
    return max > 0 ? e.scrollLeft / max : 0;
  }
  const max = e.scrollHeight - e.clientHeight;
  return max > 0 ? e.scrollTop / max : 0;
}

export function setRatio(r: number): void {
  const e = el();
  r = Math.min(1, Math.max(0, r));
  if (dual) e.scrollLeft = r * (e.scrollWidth - e.clientWidth);
  else e.scrollTop = r * (e.scrollHeight - e.clientHeight);
}

export function isAtEnd(): boolean {
  return getRatio() >= 0.999;
}

/* ========== 翻页 ========== */

export function pageDown(): void {
  const e = el();
  if (dual) e.scrollLeft += e.clientWidth;
  else e.scrollTop += e.clientHeight;
  hooks.onProgress();
}

export function pageUp(): void {
  const e = el();
  if (dual) e.scrollLeft -= e.clientWidth;
  else e.scrollTop -= e.clientHeight;
  hooks.onProgress();
}

/* ========== 滚屏引擎 ========== */

function loop(ts: number): void {
  if (!scrolling || mode !== "continuous") return;
  const dt = Math.min(100, ts - lastTs);
  lastTs = ts;
  const px = (speed * 45 * mouseFactor * dt) / 1000;
  const e = el();
  if (dual) e.scrollLeft += px;
  else e.scrollTop += px;
  if (isAtEnd()) {
    stopScroll();
    hooks.onProgress();
    hooks.onPageEnd();
    return;
  }
  rafId = requestAnimationFrame(loop);
}

export function startScroll(): void {
  if (scrolling) return;
  scrolling = true;
  mouseFactor = 1;
  el().classList.add("scroll-hidden");
  if (mode === "continuous") {
    lastTs = performance.now();
    rafId = requestAnimationFrame(loop);
  } else {
    // 页模式：到点整页翻动
    pageDown();
    pageTimer = window.setInterval(() => {
      if (isAtEnd()) {
        stopScroll();
        hooks.onPageEnd();
        return;
      }
      pageDown();
    }, Math.max(1, pageInterval) * 1000);
  }
}

export function stopScroll(): void {
  if (!scrolling) return;
  scrolling = false;
  cancelAnimationFrame(rafId);
  window.clearInterval(pageTimer);
  el().classList.remove("scroll-hidden");
}

export function toggleScroll(): boolean {
  if (scrolling) stopScroll();
  else startScroll();
  return scrolling;
}

export function isScrolling(): boolean {
  return scrolling;
}

/* ========== 模式与速度 ========== */

export function getMode(): ScrollMode {
  return mode;
}

export function setMode(m: ScrollMode): void {
  const was = scrolling;
  if (was) stopScroll();
  mode = m;
  if (was) startScroll();
}

export function getSpeed(): number {
  return speed;
}

/** 当前档位对应的基准滚动速度（像素/秒，鼠标位于屏幕中部时） */
export function speedPx(): number {
  return Math.round(speed * 45);
}

export function setSpeed(n: number): void {
  speed = Math.min(9, Math.max(1, Math.round(n * 2) / 2)); // 1..9，支持 0.5 步进
}

export function adjustSpeed(d: number): void {
  setSpeed(speed + d);
}

export function getPageInterval(): number {
  return pageInterval;
}

export function setPageInterval(sec: number): void {
  pageInterval = Math.max(1, sec);
  if (scrolling && mode === "page") {
    window.clearInterval(pageTimer);
    pageTimer = window.setInterval(() => {
      if (isAtEnd()) {
        stopScroll();
        hooks.onPageEnd();
        return;
      }
      pageDown();
    }, pageInterval * 1000);
  }
}

/* ========== 双页模式 ========== */

export function setDual(b: boolean): void {
  dual = b;
  const e = el();
  e.classList.toggle("dual-page", b);
  if (!b) e.scrollLeft = 0;
}

export function isDual(): boolean {
  return dual;
}
