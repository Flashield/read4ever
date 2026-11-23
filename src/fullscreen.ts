/* 全屏沉浸 / 无边框模式（公共功能）：沉浸隐藏与四边热区呼出为两模式共用。
   全屏 = 窗口全屏 + 界面各栏吸附屏幕边缘、鼠标碰边呼出（Tauri 桌面端走原生窗口
   全屏——macOS 标准 Space 过渡，不在原桌面残留窗口——网页元素全屏在 WKWebView
   会另开全屏窗口；浏览器演示（mock 后端）走网页 requestFullscreen，被拒时静默
   降级纯 CSS 沉浸）；无边框 = 保持窗口化，改隐藏系统标题栏（decorations）。
   两模式互斥、后开优先。插件视图内工具栏挂 .plugin-topbar / .plugin-bottombar
   即自动接入（见 docs/插件开发.md）。
   不 import app.ts（避免循环依赖）；状态变化派发 rb-fullscreen-changed 由 app 同步 UI。 */
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";

const IMMERSIVE_CLS = "fs-immersive";
const BORDERLESS_CLS = "borderless"; // 无边框专属样式钩子（如隐藏阅读区滚动条）
const EDGES = ["top", "bottom", "left", "right"] as const;
const HIDE_DELAY = 300;   // 鼠标离开后收回延时（毫秒）
const HOLD_DELAY = 1000;  // 悬停下拉时已展示边的保持延时（毫秒）

type Edge = (typeof EDGES)[number];

const hideTimers: Partial<Record<Edge, number>> = {};

/* 下拉/子菜单选择器（固定/任意定位，不在 EDGE_SELECTORS 顶边命中内） */
const DROPDOWN_SEL = ".dropdown, .dropdown-sub";

/* 每条边的呼出命中集合：热区 + 该边吸附的界面元素 */
const EDGE_SELECTORS: Record<Edge, string> = {
  top:    ".fs-hotzone-top, #menu-bar, #toolbar, #tab-bar, .plugin-topbar",
  bottom: ".fs-hotzone-bottom, #status-bar, .plugin-bottombar, #media-dock",
  left:   ".fs-hotzone-left, .side-panel.panel-left",
  right:  ".fs-hotzone-right, .side-panel:not(.panel-left)",
};

/* 浏览器演示模式（mock_backend 安装时打标记）：走网页全屏；真 Tauri 桌面走原生窗口全屏 */
function isBrowserDemo(): boolean {
  return !!(window as { __RB_BROWSER_DEMO__?: boolean }).__RB_BROWSER_DEMO__;
}

/* 我们请求过的原生全屏目标态：区分「系统侧进出全屏」（macOS 绿键/Ctrl+Cmd+F、
   Linux WM 全屏按钮）与自身调用——仅实际态 ≠ 目标态时才同步沉浸类 */
let nativeWanted = false;

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

/** 进入沉浸：挂类 + 全屏（桌面走原生窗口全屏；浏览器走网页全屏，被拒时纯 CSS 沉浸） */
export async function enter(): Promise<void> {
  document.body.classList.add(IMMERSIVE_CLS);
  if (isBrowserDemo()) {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch {
      /* 忽略：保持纯 CSS 沉浸 */
    }
  } else {
    nativeWanted = true;
    try {
      await getCurrentWindow().setFullscreen(true);
    } catch {
      /* 忽略：保持纯 CSS 沉浸 */
    }
  }
  emitChanged();
}

/** 退出沉浸：摘类与 show-* + 退出全屏（与 enter 对应的原生/网页路径） */
async function exitFullscreen(): Promise<void> {
  document.body.classList.remove(IMMERSIVE_CLS);
  EDGES.forEach(clearEdge);
  if (isBrowserDemo()) {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* 忽略 */
    }
  } else {
    nativeWanted = false;
    try {
      await getCurrentWindow().setFullscreen(false);
    } catch {
      /* 忽略 */
    }
  }
  emitChanged();
}

export async function toggle(): Promise<void> {
  if (isBorderless()) await exitBorderless(); // 与无边框互斥：全屏在后开
  if (isImmersive()) await exitFullscreen();
  else await enter();
}

/* ========== 无边框模式（窗口化沉浸）：同一套隐藏/热区机制，不进系统全屏，
   改隐藏系统标题栏（decorations）；浏览器演示无窗口装饰概念，仅 CSS 部分。 */

export function isBorderless(): boolean {
  return document.body.classList.contains(BORDERLESS_CLS);
}

/** 进入无边框：先退出全屏（互斥），挂沉浸类 + 无边框类，桌面端隐藏窗口装饰 */
export async function enterBorderless(): Promise<void> {
  if (isImmersive()) await exitFullscreen();
  document.body.classList.add(IMMERSIVE_CLS, BORDERLESS_CLS);
  if (!isBrowserDemo()) {
    try {
      await getCurrentWindow().setDecorations(false);
    } catch {
      /* 忽略：保持纯 CSS 沉浸 */
    }
  }
  emitChanged();
}

/** 退出无边框：摘类还原各栏，桌面端恢复窗口装饰 */
export async function exitBorderless(): Promise<void> {
  document.body.classList.remove(IMMERSIVE_CLS, BORDERLESS_CLS);
  EDGES.forEach(clearEdge);
  if (!isBrowserDemo()) {
    try {
      await getCurrentWindow().setDecorations(true);
    } catch {
      /* 忽略 */
    }
  }
  emitChanged();
}

export async function toggleBorderless(): Promise<void> {
  if (isBorderless()) await exitBorderless();
  else await enterBorderless();
}

/* ========== 无边框中央拖动移窗：标题栏隐藏后由阅读区代管窗口拖动。
   监听面是 #reader-container（文本阅读区与插件视图宿主同在其内——视频/PDF
   等插件视图激活时覆盖阅读区，只挂 reader-content 会漏掉最常见的恢复场景）。
   按下后位移超阈值才进入自管拖动，此后按「mousedown 时窗口位 + screenX/Y
   增量 × 缩放」setPosition 跟随（绝对对齐，不累积漂移）。
   坐标必须用 screenX/Y：clientX/Y 相对窗口原点，窗口一移动、误差信号即被
   自身位移抵消（目标位恒被拉回，窗口半速跟移甚至原地抖动）；screenX/Y 锚定
   屏幕，窗口移动不影响其值（拖窗时光标钉在窗口内抓取点，事件流不断）。
   不走 tao 的 start_dragging——macOS 下它要求 currentEvent 恰为发起拖动的
   mouseDown，从 mousemove 阈值进来 AppKit 静默拒绝（见无边框拖窗设计文档）；
   也不用 cursorPosition()——tao 的 macOS 实现把 mouseLocation 点坐标与
   像素高度混算，与 setPosition 的物理像素不可换算。
   取词/视频点击是 WebKit 原生行为（mousedown 默认），不能 preventDefault；
   超阈值即拖窗、不足 5px 仍是点击（双击取词、视频暂停不受影响）；拖动中
   每次移动压住原生拖选（无边框期间拖选文字本就让位于拖窗，退出无边框一切恢复）。
   左右面板/各栏均在 reader-container 之外不会命中；浏览器演示无窗口概念，
   不启用；普通窗口模式有标题栏，不引入。 */
const DRAG_THRESHOLD = 5; // 位移超过此像素数才判为拖窗

let dragArmed = false; // 拖窗武装：合法按下且窗口位就绪后置位，超阈触发或 mouseup 解除
let dragging = false; // 自管拖动进行中（超阈后）
let dragX = 0; // mousedown 起点（webview CSS px，仅判阈）
let dragY = 0;
let dragSX = 0; // mousedown 起点（屏幕坐标，screenX/Y 锚定屏幕，窗口移动不影响）
let dragSY = 0;
let winX = 0; // mousedown 时窗口左上角（物理 px）
let winY = 0;
let winScale = 1; // 缩放：CSS px → 物理 px（跨不同缩放显示器的拖动会有轻微误差，可接受）

function initBorderlessDrag(): void {
  const el = document.getElementById("reader-container");
  if (!el) return;
  el.addEventListener("mousedown", (e) => {
    dragArmed = false;
    dragging = false;
    if (!isBorderless() || isBrowserDemo() || e.button !== 0) return;
    dragX = e.clientX;
    dragY = e.clientY;
    dragSX = e.screenX;
    dragSY = e.screenY;
    // 先取窗口位与缩放再武装：未就绪前超阈不触发（IPC 毫秒级，人手 5px 远慢于此）
    const win = getCurrentWindow();
    void Promise.all([win.outerPosition(), win.scaleFactor()])
      .then(([pos, scale]) => {
        winX = pos.x;
        winY = pos.y;
        winScale = scale;
        dragArmed = true;
      })
      .catch(() => {
        /* 取窗口位失败则本次按下不武装 */
      });
  });
  el.addEventListener("mousemove", (e) => {
    if (!dragArmed) return;
    if (Math.hypot(e.clientX - dragX, e.clientY - dragY) < DRAG_THRESHOLD) return;
    dragArmed = false;
    dragging = true;
    window.getSelection()?.removeAllRanges(); // 清掉半截选区，让位于拖窗
  });
  // 跟随与收尾挂 window 层：读区外持续；拖窗时窗口跟着光标走，光标不会出窗
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    window.getSelection()?.removeAllRanges(); // 压住原生拖选
    void getCurrentWindow()
      .setPosition(
        new PhysicalPosition(
          Math.round(winX + (e.screenX - dragSX) * winScale),
          Math.round(winY + (e.screenY - dragSY) * winScale),
        ),
      )
      .catch(() => {
        /* 忽略 */
      });
  });
  window.addEventListener("mouseup", () => {
    dragArmed = false;
    dragging = false;
  });
  window.addEventListener("blur", () => {
    dragArmed = false;
    dragging = false; // 拖动中被系统弹层抢走焦点即停
  });
}

/* ========== 窗口置顶（公共功能）：生效规则纯派生——
   置顶 ＝ 「总是在最顶端」(手动开关，即时状态不跨会话) ‖ 「播放时置顶」(播放期间的临时诉求，
   由 app 侧播放开关联动/兜底监视驱动)。浏览器演示无窗口置顶概念，仅维护状态供 UI 高亮。 */

let alwaysTop = false; // 「总是在最顶端」手动开关
let playTopWanted = false; // 「播放时置顶」当前的临时诉求（播放中为 true）
let appliedOnTop = false; // 已生效的派生态（去重，避免重复调用窗口 API / 重复派发事件）

function applyOnTop(): void {
  const want = alwaysTop || playTopWanted;
  if (want === appliedOnTop) return;
  appliedOnTop = want;
  if (!isBrowserDemo()) {
    try {
      void getCurrentWindow().setAlwaysOnTop(want);
    } catch {
      /* 忽略 */
    }
  }
  emitChanged();
}

/** 当前是否置顶生效（派生态，供工具栏/菜单高亮） */
export function isOnTop(): boolean {
  return appliedOnTop;
}

/** 翻转「总是在最顶端」手动开关，返回新状态 */
export function toggleAlwaysTop(): boolean {
  alwaysTop = !alwaysTop;
  applyOnTop();
  return alwaysTop;
}

/** 播放置顶诉求（app 侧在播放开始/确认结束时调用；幂等） */
export function setPlaybackOnTop(on: boolean): void {
  if (playTopWanted === on) return;
  playTopWanted = on;
  applyOnTop();
}

export function initFullscreen(): void {
  initBorderlessDrag(); // 无边框期间阅读区中央拖动移窗

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

  // 原生全屏对账：窗口尺寸变化时比对实际态与目标态，系统侧进出全屏
  // （macOS 绿键/Ctrl+Cmd+F、Linux WM 全屏按钮）也能同步挂/摘沉浸类
  window.addEventListener("resize", () => {
    if (isBrowserDemo()) return;
    getCurrentWindow()
      .isFullscreen()
      .then((fs) => {
        if (fs === nativeWanted) return;
        nativeWanted = fs;
        // 无边框期间系统侧进出全屏不动沉浸类（无边框的隐藏与全屏对账无关，保持自身状态）
        if (isBorderless()) {
          emitChanged();
          return;
        }
        document.body.classList.toggle(IMMERSIVE_CLS, fs);
        if (!fs) EDGES.forEach(clearEdge);
        emitChanged();
      })
      .catch(() => {});
  });

  // 网页全屏下 Esc 由浏览器原生退出，这里同步清理沉浸类（无边框不参与网页全屏生命周期）
  document.addEventListener("fullscreenchange", () => {
    if (isBorderless()) return;
    if (!document.fullscreenElement && document.body.classList.contains(IMMERSIVE_CLS)) {
      document.body.classList.remove(IMMERSIVE_CLS);
      EDGES.forEach(clearEdge);
      emitChanged();
    }
  });
}
