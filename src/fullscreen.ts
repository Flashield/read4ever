/* 全屏沉浸模式（公共功能）：窗口全屏 + 界面各栏吸附屏幕边缘、鼠标碰边呼出。
   插件视图内工具栏挂 .plugin-topbar / .plugin-bottombar 即自动接入（见 docs/插件开发.md）。
   不 import app.ts（避免循环依赖）；状态变化派发 rb-fullscreen-changed 由 app 同步 UI。 */

const IMMERSIVE_CLS = "fs-immersive";
const EDGES = ["top", "bottom", "left", "right"] as const;
const HIDE_DELAY = 300;   // 鼠标离开后收回延时（毫秒）
const HOLD_DELAY = 1000;  // 悬停下拉时已展示边的保持延时（毫秒）

type Edge = (typeof EDGES)[number];

const hideTimers: Partial<Record<Edge, number>> = {};

/* 下拉/子菜单选择器（固定/任意定位，不在 EDGE_SELECTORS 顶边命中内） */
const DROPDOWN_SEL = ".dropdown, .dropdown-sub";

/* 每条边的呼出命中集合：热区 + 该边吸附的界面元素 */
const EDGE_SELECTORS: Record<Edge, string> = {
  top:    ".fs-hotzone-top, #menu-bar, #toolbar, .plugin-topbar",
  bottom: ".fs-hotzone-bottom, #status-bar, .plugin-bottombar",
  left:   ".fs-hotzone-left, .side-panel.panel-left",
  right:  ".fs-hotzone-right, .side-panel:not(.panel-left)",
};

export function isImmersive(): boolean {
  return !!document.fullscreenElement || document.body.classList.contains(IMMERSIVE_CLS);
}

function clearEdge(edge: Edge): void {
  window.clearTimeout(hideTimers[edge]);
  document.body.classList.remove("show-" + edge);
}

function showEdge(edge: Edge): void {
  window.clearTimeout(hideTimers[edge]);
  document.body.classList.add("show-" + edge);
}

function scheduleHide(edge: Edge): void {
  window.clearTimeout(hideTimers[edge]);
  hideTimers[edge] = window.setTimeout(() => clearEdge(edge), HIDE_DELAY);
}

/** 悬停下拉时保持已展示边（不清，仅续延时） */
function holdEdge(edge: Edge): void {
  window.clearTimeout(hideTimers[edge]);
  hideTimers[edge] = window.setTimeout(() => clearEdge(edge), HOLD_DELAY);
}

function edgeOf(t: HTMLElement | null): Edge | null {
  if (!t) return null;
  for (const edge of EDGES) {
    if (t.closest(EDGE_SELECTORS[edge])) return edge;
  }
  return null;
}

function emitChanged(): void {
  document.dispatchEvent(new CustomEvent("rb-fullscreen-changed"));
}

/** 进入沉浸：挂类 + 网页全屏（被拒如非用户手势时静默降级为纯 CSS 沉浸） */
export async function enter(): Promise<void> {
  document.body.classList.add(IMMERSIVE_CLS);
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  } catch {
    /* 忽略：保持纯 CSS 沉浸 */
  }
  emitChanged();
}

/** 退出沉浸：摘类与 show-* + 退出网页全屏 */
export async function exitFullscreen(): Promise<void> {
  document.body.classList.remove(IMMERSIVE_CLS);
  EDGES.forEach(clearEdge);
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* 忽略 */
  }
  emitChanged();
}

export async function toggle(): Promise<void> {
  if (isImmersive()) await exitFullscreen();
  else await enter();
}

export function initFullscreen(): void {
  // 四边热区（CSS 控制仅沉浸时显示）
  for (const edge of EDGES) {
    const z = document.createElement("div");
    z.className = "fs-hotzone fs-hotzone-" + edge;
    document.body.appendChild(z);
  }

  // 碰边呼出 / 离开延时收回：mouseover 冒泡 + closest 命中集合；
  // mouseout 用 relatedTarget 判重，仍在同边集合内不动作；
  // 下拉可锚定在屏幕任意位置，悬停其中保持已展示边，不新增
  document.addEventListener("mouseover", (e) => {
    if (!isImmersive()) return;
    const t = e.target as HTMLElement;
    const edge = edgeOf(t);
    if (edge) {
      showEdge(edge);
      return;
    }
    // 下拉悬停：保持已展示边，用较长的 HOLD 延时防止 stationary 阅读菜单时锚点栏收回
    if (t.closest(DROPDOWN_SEL)) {
      EDGES.forEach((eg) => {
        if (document.body.classList.contains("show-" + eg)) holdEdge(eg);
      });
    }
  });
  document.addEventListener("mouseout", (e) => {
    if (!isImmersive()) return;
    const t = e.target as HTMLElement;
    const to = e.relatedTarget as HTMLElement | null;

    // 从下拉移出到非下拉内容：因悬停而保持的边延时收回
    if (t.closest(DROPDOWN_SEL) && !(to && to.closest(DROPDOWN_SEL))) {
      EDGES.forEach((eg) => {
        if (document.body.classList.contains("show-" + eg)) scheduleHide(eg);
      });
      return;
    }

    // 从边相关元素移出：仍在同边命中集合内不动作
    const edge = edgeOf(t);
    if (!edge) return;
    if (to && to.closest(EDGE_SELECTORS[edge])) return;
    scheduleHide(edge);
  });

  // 网页全屏下 Esc 由浏览器原生退出，这里同步清理沉浸类
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains(IMMERSIVE_CLS)) {
      document.body.classList.remove(IMMERSIVE_CLS);
      EDGES.forEach(clearEdge);
      emitChanged();
    }
  });
}
