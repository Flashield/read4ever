/* 通用下拉菜单：菜单栏、ZIP 条目选择、编码选择、插件子菜单共用。
   支持层级子菜单：条目带 children 时悬停展开下一级（✓ 状态展开时即时求值）。 */
import { perfLine } from "./debug-perf"; // 【临时调试】

export interface MenuItemDef {
  label?: string;
  shortcut?: string;
  action?: () => void;
  checked?: () => boolean;
  sep?: boolean;
  disabled?: boolean;
  customEl?: HTMLElement;
  /** 子菜单（懒构建：展开时求值） */
  children?: () => MenuItemDef[];
}

interface Level {
  el: HTMLElement;
  content: HTMLElement;
}

let levels: Level[] = [];
let open = false;
let closeCallback: (() => void) | null = null;

export function isOpen(): boolean {
  return levels.length > 0;
}

function levelAt(depth: number): Level {
  while (levels.length <= depth) {
    if (levels.length === 0) {
      const el = document.getElementById("menu-dropdown")!;
      const content = document.getElementById("dropdown-content")!;
      levels.push({ el, content });
    } else {
      const el = document.createElement("div");
      el.className = "dropdown dropdown-sub hidden";
      const content = document.createElement("div");
      content.className = "dropdown-content";
      el.appendChild(content);
      document.body.appendChild(el);
      levels.push({ el, content });
    }
  }
  return levels[depth];
}

/** 收起 depth 之后的所有层级（level 0 宿主隐藏，更深宿主移除） */
function truncateTo(depth: number): void {
  while (levels.length > depth) {
    const l = levels.pop()!;
    if (l.el.id === "menu-dropdown") {
      l.el.classList.add("hidden");
      // 只清空列表内容，不能清空容器本身（#dropdown-content 被删掉后菜单会永久失效）
      const content = document.getElementById("dropdown-content");
      if (content) content.innerHTML = "";
    } else {
      l.el.remove();
    }
  }
}

export function hideDropdown(): void {
  truncateTo(0);
  open = false;
  document.querySelectorAll(".menu-item.active").forEach((m) => m.classList.remove("active"));
  const cb = closeCallback;
  closeCallback = null;
  cb?.();
}

/** 在指定层级展开菜单项（level 0 = 顶部菜单，>0 = 子菜单） */
export function showDropdownAt(depth: number, items: MenuItemDef[], x: number, y: number): void {
  const tt = performance.now(); // 【临时调试】
  truncateTo(depth + 1);
  const lv = levelAt(depth);
  lv.content.innerHTML = "";

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement("div");
      sep.className = "dropdown-sep";
      lv.content.appendChild(sep);
      continue;
    }
    if (item.customEl) {
      const row = document.createElement("div");
      row.className = "dropdown-item dropdown-custom";
      row.addEventListener("mousedown", (e) => e.stopPropagation());
      row.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(item.customEl);
      lv.content.appendChild(row);
      continue;
    }
    const row = document.createElement("div");
    row.className = "dropdown-item" + (item.disabled ? " disabled" : "");
    const label = document.createElement("span");
    label.textContent = (item.checked?.() ? "✓ " : "") + (item.label ?? "");
    row.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "dropdown-shortcut";
      sc.textContent = item.shortcut;
      row.appendChild(sc);
    }
    if (item.children) {
      // 子菜单条目：悬停展开下一级，右侧箭头指示
      row.classList.add("has-children");
      const arrow = document.createElement("span");
      arrow.className = "dropdown-arrow";
      arrow.textContent = "▸";
      row.appendChild(arrow);
      row.addEventListener("mousedown", (e) => e.stopPropagation());
      const openChild = () => {
        const r = row.getBoundingClientRect();
        showDropdownAt(depth + 1, item.children!(), r.right - 4, r.top - 6);
      };
      row.addEventListener("mouseenter", openChild);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        openChild();
      });
    } else {
      row.addEventListener("mouseenter", () => truncateTo(depth + 1));
      if (!item.disabled) {
        row.addEventListener("mousedown", (e) => e.stopPropagation());
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          hideDropdown();
          item.action?.();
        });
      }
    }
    lv.content.appendChild(row);
  }

  lv.el.classList.remove("hidden");
  open = true;
  // 定位并防止超出窗口（子菜单右侧放不下时翻到左侧）
  const rect = lv.content.getBoundingClientRect();
  let left = x;
  let top = y;
  if (depth > 0 && left + rect.width > window.innerWidth - 8) left = Math.max(4, x - rect.width - 12);
  top = Math.min(top, window.innerHeight - Math.min(rect.height, window.innerHeight * 0.7) - 8);
  lv.el.style.left = Math.max(4, left) + "px";
  lv.el.style.top = Math.max(4, top) + "px";
  perfLine(`showDropdownAt depth=${depth} ${items.length}项 耗时 ${(performance.now() - tt).toFixed(0)}ms`); // 【临时调试】
}

/** 顶部菜单展开（保持原签名，现有调用方不变） */
export function showDropdown(items: MenuItemDef[], x: number, y: number, onClose?: () => void): void {
  const prev = closeCallback;
  closeCallback = null;
  prev?.();
  showDropdownAt(0, items, x, y);
  closeCallback = onClose ?? null;
}

/* 点击空白处关闭；Esc 由 shortcut.ts 处理 */
export function initDropdown(): void {
  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node;
    if (open && !levels.some((l) => l.el.contains(t))) {
      hideDropdown();
    }
  });
}
