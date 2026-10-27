/* 侧边面板：书签、收藏书架、历史记录、外观方案 */
import * as app from "./app";
import { BUILT_IN_THEMES, findThemeByName, getAllThemeNames, FONT_OPTIONS } from "./themes";
import type { CustomTheme } from "./types";

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

const PANELS = ["bookmark-panel", "bookshelf-panel", "history-panel", "theme-panel", "keyword-panel", "plugin-panel"];

export const PANEL_MIN_W = 240;
export const PANEL_MAX_W = 720;

function widthVar(side: "left" | "right"): string {
  return side === "left" ? "--panel-w-left" : "--panel-w";
}

export function panelWidth(id: string): number {
  let w = 0;
  try {
    w = parseInt(localStorage.getItem("rb-panel-w-" + id) || "", 10) || 0;
  } catch {
    /* localStorage 不可用时用默认宽度 */
  }
  if (w < PANEL_MIN_W) w = id === "keyword-panel" ? 360 : 300;
  return Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, w));
}

export function applyPanelWidth(id: string, w: number, side: "left" | "right" = "right"): void {
  const panel = document.getElementById(id);
  if (panel) panel.style.width = w + "px";
  // 阅读区让位与查找栏避让共用这些变量
  document.documentElement.style.setProperty(widthVar(side), w + "px");
}

function clampPanelWidth(w: number): number {
  return Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.min(w, window.innerWidth - 280)));
}

/* 面板边缘拖拽调宽（宽度按面板分别记忆；side 决定手柄与拖动方向） */
export function initPanelResize(panel: HTMLElement, side: "left" | "right" = "right"): void {
  const handle = document.createElement("div");
  handle.className = "panel-resize" + (side === "left" ? " at-right" : "");
  handle.title = "拖拽调整面板宽度";
  panel.appendChild(handle);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      applyPanelWidth(panel.id, clampPanelWidth(startW + delta), side);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem("rb-panel-w-" + panel.id, panel.style.width);
      } catch {
        /* 忽略 */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

export function openPanel(id: string): void {
  PANELS.forEach((p) => $(p).classList.add("hidden"));
  applyPanelWidth(id, panelWidth(id));
  $(id).classList.remove("hidden");
  document.body.classList.add("panel-open");
  if (id === "bookmark-panel") renderBookmarks();
  if (id === "bookshelf-panel") renderBookshelf();
  if (id === "history-panel") renderHistory();
  if (id === "theme-panel") syncThemeControls();
}

export function closeAllPanels(): void {
  PANELS.forEach((p) => $(p).classList.add("hidden"));
  document.body.classList.remove("panel-open");
}

export function isAnyPanelOpen(): boolean {
  return PANELS.some((p) => !$(p).classList.contains("hidden"));
}

/* ========== 列表渲染 ========== */

function rowEl(name: string, desc: string, onDelete?: () => void, onClick?: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "list-item";
  const info = document.createElement("div");
  info.className = "list-item-info";
  const n = document.createElement("div");
  n.className = "item-name";
  n.textContent = name;
  const d = document.createElement("div");
  d.className = "item-desc";
  d.textContent = desc;
  info.appendChild(n);
  info.appendChild(d);
  row.appendChild(info);
  if (onClick) {
    info.addEventListener("click", onClick);
  } else {
    row.style.cursor = "default";
  }
  if (onDelete) {
    const btn = document.createElement("button");
    btn.className = "item-delete";
    btn.textContent = "✕";
    btn.title = "删除";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });
    row.appendChild(btn);
  }
  return row;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

function renderBookmarks(): void {
  const list = $("bookmark-list");
  list.innerHTML = "";
  const all = app.state.store.bookmarks;
  if (all.length === 0) {
    list.innerHTML = '<div style="padding:16px;font-size:12px;color:#888">暂无书签。按 Ctrl+B 在当前位置快速添加。</div>';
    return;
  }
  all.forEach((b, i) => {
    const isCurrent = b.filePath === app.state.filePath;
    list.appendChild(
      rowEl(
        b.description,
        `${isCurrent ? "本书" : b.filePath.split(/[\\/:]/).pop() || b.filePath} · ${fmtTime(b.created)} · ${Math.round(b.position * 100)}%`,
        () => app.deleteBookmarkAt(i),
        () => app.jumpBookmark(b.filePath, b.position)
      )
    );
  });
}

function renderBookshelf(): void {
  const list = $("bookshelf-list");
  list.innerHTML = "";
  const shelf = app.activeShelf();
  if (shelf.items.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:16px;font-size:12px;color:#888";
    empty.textContent = "书架空空如也。打开一本书后点「添加当前」收进来。";
    list.appendChild(empty);
    return;
  }
  shelf.items.forEach((b) => {
    list.appendChild(
      rowEl(b.name, `加入于 ${fmtTime(b.added)}`, () => app.deleteBookshelfItem(shelf.id, b.filePath), () => app.openPath(b.filePath))
    );
  });
}

function renderHistory(): void {
  const list = $("history-list");
  list.innerHTML = "";
  const all = app.state.store.history;
  if (all.length === 0) {
    list.innerHTML = '<div style="padding:16px;font-size:12px;color:#888">暂无阅读记录。</div>';
    return;
  }
  all.forEach((h, i) => {
    list.appendChild(
      rowEl(
        h.fileName,
        `${fmtTime(h.lastRead)} · 读过 ${fmtDuration(h.readSeconds)} · ${Math.round(h.position * 100)}%`,
        () => app.deleteHistoryAt(i),
        () => app.openPath(h.filePath)
      )
    );
  });
}

/* ========== 外观方案面板 ========== */

function rebuildThemeSelect(): void {
  const sel = $("theme-select") as HTMLSelectElement;
  const s = app.state.store.settings;
  sel.innerHTML = "";
  for (const name of getAllThemeNames(s.customThemes)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = s.themeName;
  if (sel.value !== s.themeName && sel.options.length) {
    const custom = document.createElement("option");
    custom.value = s.themeName;
    custom.textContent = s.themeName;
    sel.appendChild(custom);
    sel.value = s.themeName;
  }
}

function syncThemeControls(): void {
  const s = app.state.store.settings;
  const t = findThemeByName(s.themeName, s.customThemes);
  const isCustom = !t && s.themeName === "自定义";
  rebuildThemeSelect();
  ($("bg-color") as HTMLInputElement).value = t?.bg ?? (isCustom ? s.customBg || "#ffffff" : "#ffffff");
  ($("text-color") as HTMLInputElement).value = t?.text ?? (isCustom ? s.customText || "#000000" : "#000000");
  const fontSel = $("font-family") as HTMLSelectElement;
  fontSel.value = s.fontFamily;
  if (fontSel.value !== s.fontFamily) {
    const opt = document.createElement("option");
    opt.value = s.fontFamily;
    opt.textContent = s.fontFamily;
    fontSel.appendChild(opt);
    fontSel.value = s.fontFamily;
  }
  ($("font-size") as HTMLInputElement).value = String(s.fontSize);
  $("font-size-val").textContent = String(s.fontSize);
  ($("line-spacing") as HTMLInputElement).value = String(s.lineSpacing);
  $("line-spacing-val").textContent = String(s.lineSpacing);
  document.querySelectorAll(".size-preset").forEach((b) => {
    b.classList.toggle("active", Number((b as HTMLElement).dataset.size) === s.fontSize);
  });
}

function reapplyLook(): void {
  const s = app.state.store.settings;
  const bg = ($("bg-color") as HTMLInputElement).value;
  const text = ($("text-color") as HTMLInputElement).value;
  const t = findThemeByName(s.themeName, s.customThemes);
  if (t && t.bg === bg && t.text === text) {
    app.applyAppearance();
  } else {
    app.applyCustomLook(bg, text);
  }
  s.fontFamily = ($("font-family") as HTMLSelectElement).value;
  s.fontSize = Number(($("font-size") as HTMLInputElement).value);
  s.lineSpacing = Number(($("line-spacing") as HTMLInputElement).value);
  $("font-size-val").textContent = String(s.fontSize);
  $("line-spacing-val").textContent = String(s.lineSpacing);
  document.querySelectorAll(".size-preset").forEach((b) => {
    b.classList.toggle("active", Number((b as HTMLElement).dataset.size) === s.fontSize);
  });
  app.applyAppearance();
  document.dispatchEvent(new CustomEvent("rb-theme-changed"));
}

function initThemePanel(): void {
  // 字体下拉改为跨平台字体栈选项（Windows/macOS 各有对应字体）
  const fontSel = $("font-family") as HTMLSelectElement;
  fontSel.innerHTML = "";
  for (const f of FONT_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = f.value;
    opt.textContent = f.label;
    fontSel.appendChild(opt);
  }

  $("theme-select").addEventListener("change", () => {
    const name = ($("theme-select") as HTMLSelectElement).value;
    app.applyThemeByName(name);
    syncThemeControls();
  });
  $("bg-color").addEventListener("input", reapplyLook);
  $("text-color").addEventListener("input", reapplyLook);
  $("font-family").addEventListener("change", reapplyLook);
  $("font-size").addEventListener("input", () => {
    $("font-size-val").textContent = ($("font-size") as HTMLInputElement).value;
    reapplyLook();
  });
  $("line-spacing").addEventListener("input", () => {
    $("line-spacing-val").textContent = ($("line-spacing") as HTMLInputElement).value;
    reapplyLook();
  });
  document.querySelectorAll(".size-preset").forEach((b) => {
    b.addEventListener("click", () => {
      ($("font-size") as HTMLInputElement).value = (b as HTMLElement).dataset.size || "18";
      reapplyLook();
    });
  });
  $("save-custom-theme").addEventListener("click", () => {
    const s = app.state.store.settings;
    const nameInput = $("custom-theme-name") as HTMLInputElement;
    const name = nameInput.value.trim() || `自定义${s.customThemes.length + 1}`;
    if ([...BUILT_IN_THEMES.map((t) => t.name)].includes(name)) {
      app.toast("不能使用内置方案名称");
      return;
    }
    const cur = findThemeByName(name, s.customThemes);
    const theme: CustomTheme = {
      name,
      bg: ($("bg-color") as HTMLInputElement).value,
      text: ($("text-color") as HTMLInputElement).value,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineSpacing: s.lineSpacing,
    };
    if (cur) {
      s.customThemes[s.customThemes.indexOf(cur)] = theme;
    } else {
      s.customThemes.push(theme);
    }
    s.themeName = name;
    nameInput.value = "";
    app.persist();
    app.toast(`已保存方案「${name}」`);
    rebuildThemeSelect();
  });
}

/* ========== 初始化 ========== */

export function initPanels(): void {
  document.querySelectorAll(".side-panel .panel-close").forEach((btn) => {
    btn.addEventListener("click", closeAllPanels);
  });
  PANELS.forEach((id) => {
    const panel = document.getElementById(id);
    if (panel) initPanelResize(panel);
  });

  $("bookmark-add").addEventListener("click", () => {
    const desc = ($("bookmark-desc") as HTMLInputElement).value.trim();
    app.addBookmark(desc || undefined);
    ($("bookmark-desc") as HTMLInputElement).value = "";
    renderBookmarks();
  });
  $("bookmark-desc").addEventListener("keydown", (e) => {
    if (e.key === "Enter") ($("bookmark-add") as HTMLButtonElement).click();
  });

  $("bookshelf-add").addEventListener("click", () => {
    const name = ($("bookshelf-name") as HTMLInputElement).value.trim();
    app.addToBookshelf(name || undefined);
    ($("bookshelf-name") as HTMLInputElement).value = "";
    renderBookshelf();
  });
  $("bookshelf-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") ($("bookshelf-add") as HTMLButtonElement).click();
  });

  $("history-clear").addEventListener("click", () => app.clearHistory());

  initThemePanel();

  // 跨模块事件
  document.addEventListener("rb-open-panel", (e) => openPanel((e as CustomEvent).detail as string));
  document.addEventListener("rb-escape", () => closeAllPanels());
  document.addEventListener("rb-store-changed", () => {
    if (!$("bookmark-panel").classList.contains("hidden")) renderBookmarks();
    if (!$("bookshelf-panel").classList.contains("hidden")) renderBookshelf();
    if (!$("history-panel").classList.contains("hidden")) renderHistory();
  });
  document.addEventListener("rb-theme-changed", () => {
    if (!$("theme-panel").classList.contains("hidden")) syncThemeControls();
  });
}
