/* 左侧文件夹侧栏：树状浏览（懒展开）+ 文件列表（递归/过滤）+ 文件操作 */
import { api } from "./api";
import * as app from "./app";
import { showDropdown, type MenuItemDef } from "./dropdown";
import { canOpenFile } from "./plugins/registry";
import { applyPanelWidth, initPanelResize, panelWidth } from "./panels";
import type { FileEntry } from "./types";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const SCAN_CAP = 2000; // 递归扫描文件数上限

let root = "";
let open = false;
let expanded = new Set<string>();
const childrenCache = new Map<string, FileEntry[]>();
const nodeRows = new Map<string, HTMLElement>(); // 目录路径 → 树节点元素（行内编辑定位用）
let listRecursive = false;
let filterText = "";

const panelEl = () => $("folder-panel");

/* ========== 本地 / 远程标签页 ========== */

/** 切换左侧面板标签（本地/远程）；远程首切时渲染服务器树。持久化到 settings.folderTab */
export async function switchSideTab(tab: "local" | "smb"): Promise<void> {
  $("lptab-local").classList.toggle("active", tab === "local");
  $("lptab-smb").classList.toggle("active", tab === "smb");
  $("folder-local").classList.toggle("hidden", tab !== "local");
  $("folder-smb").classList.toggle("hidden", tab !== "smb");
  app.state.store.settings.folderTab = tab === "smb" ? "smb" : "";
  app.persist();
  if (tab === "smb") {
    await import("./smb").then((m) => m.ensureRendered());
  }
}

/* ========== 打开 / 关闭 ========== */

export async function openFolderPanel(): Promise<void> {
  if (open) {
    await renderAll();
    return;
  }
  open = true;
  applyPanelWidth("folder-panel", panelWidth("folder-panel"), "left");
  panelEl().classList.remove("hidden");
  document.body.classList.add("folder-open");
  const s = app.state.store.settings;
  listRecursive = !!s.folderListRecursive;
  ($("folder-recursive") as HTMLInputElement).checked = listRecursive;
  // 恢复上次使用的标签（本地/远程）
  await switchSideTab(s.folderTab === "smb" ? "smb" : "local");
  if (!root && s.lastFolderPath) {
    await setRoot(s.lastFolderPath);
  } else {
    await renderAll();
  }
}

function closeFolderPanel(): void {
  if (!open) return;
  open = false;
  panelEl().classList.add("hidden");
  document.body.classList.remove("folder-open");
}

/** 弹出目录选择框并打开所选文件夹 */
export async function pickFolder(): Promise<void> {
  const dir = await api.pickDirectory();
  if (!dir) return;
  await openFolderPanel();
  await setRoot(dir);
}

async function setRoot(path: string): Promise<void> {
  root = path;
  expanded = new Set([path]);
  childrenCache.clear();
  app.state.store.settings.lastFolderPath = path;
  app.persist();
  await renderAll();
}

async function refresh(): Promise<void> {
  childrenCache.clear();
  await renderAll();
}

/** 在文件夹栏中定位文件：必要时切换根目录、逐级展开、滚动到位并短暂高亮 */
export async function revealFile(path: string): Promise<void> {
  if (!path) return;
  await openFolderPanel();
  if (path.startsWith("smb://")) {
    // 远程路径：切远程标签，由 smb 模块展开定位
    await switchSideTab("smb");
    await import("./smb").then((m) => m.revealRemote(path));
    return;
  }
  const sep = path.includes("\\") ? "\\" : "/";
  const dirPath = path.slice(0, Math.max(path.lastIndexOf(sep), 0));
  if (!root || !path.startsWith(root)) {
    await setRoot(dirPath); // 不在当前根内：直接把根切到文件所在目录
  } else {
    // 展开从根到文件的所有祖先目录
    const relDir = dirPath.slice(root.length).replace(/^[/\\]+/, "");
    let acc = root.replace(/[/\\]+$/, "");
    for (const part of relDir.split(/[/\\]+/).filter(Boolean)) {
      acc = acc + sep + part;
      expanded.add(acc);
    }
    await refresh();
  }
  const row = rowByPath(path);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.classList.add("located");
    window.setTimeout(() => row.classList.remove("located"), 2000);
  }
}

/* ========== 数据 ========== */

async function loadChildren(dir: string): Promise<FileEntry[]> {
  const cached = childrenCache.get(dir);
  if (cached) return cached;
  try {
    const entries = await api.listDir(dir, app.state.store.settings.naturalSort);
    childrenCache.set(dir, entries);
    return entries;
  } catch (e) {
    app.toast(String(e).slice(0, 60));
    childrenCache.set(dir, []);
    return [];
  }
}

function pathToName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

interface ListItem {
  path: string;
  name: string;
  rel: string;
  size: number;
  mtime: number;
}

async function collectFiles(): Promise<ListItem[]> {
  const out: ListItem[] = [];
  const rel = (p: string) =>
    root && p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]+/, "") : p;
  if (!listRecursive) {
    for (const e of await loadChildren(root)) {
      if (!e.isDir && canOpenFile(e.name)) {
        out.push({ path: e.path, name: e.name, rel: e.name, size: e.size, mtime: e.mtime });
      }
    }
    return out;
  }
  const queue = [root];
  while (queue.length && out.length < SCAN_CAP) {
    for (const e of await loadChildren(queue.shift()!)) {
      if (out.length >= SCAN_CAP) break;
      if (e.isDir) queue.push(e.path);
      else if (canOpenFile(e.name)) {
        out.push({ path: e.path, name: e.name, rel: rel(e.path), size: e.size, mtime: e.mtime });
      }
    }
  }
  return out;
}

/* ========== 渲染 ========== */

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function renderAll(): Promise<void> {
  $("folder-path").textContent = root ? pathToName(root) : "未选择文件夹";
  $("folder-path").title = root;
  await renderTree();
  await renderList();
}

async function renderTree(): Promise<void> {
  const box = $("folder-tree");
  const keepScroll = box.scrollTop; // 重建后保持滚动位置（展开/删除/重命名时不跳顶）
  box.innerHTML = "";
  nodeRows.clear();
  if (!root) {
    box.innerHTML = '<div class="kw-empty">点击上方「📂 选择文件夹」浏览本地书籍目录</div>';
    return;
  }
  box.appendChild(await buildNode(root, pathToName(root), 0, expanded.has(root)));
  box.scrollTop = keepScroll;
}

async function buildNode(
  dirPath: string,
  name: string,
  depth: number,
  isExpanded: boolean
): Promise<HTMLElement> {
  const node = document.createElement("div");
  node.className = "ft-node";
  node.appendChild(treeRow(dirPath, name, depth, true, isExpanded, true));
  nodeRows.set(dirPath, node);
  if (isExpanded) {
    const kids = document.createElement("div");
    kids.className = "ft-kids";
    const entries = await loadChildren(dirPath);
    for (const e of entries) {
      if (e.isDir) {
        kids.appendChild(await buildNode(e.path, e.name, depth + 1, expanded.has(e.path)));
      } else {
        kids.appendChild(treeRow(e.path, e.name, depth + 1, false, false, canOpenFile(e.name)));
      }
    }
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ft-emptyline";
      empty.style.paddingLeft = depth * 14 + 30 + "px";
      empty.textContent = "（空）";
      kids.appendChild(empty);
    }
    node.appendChild(kids);
  }
  return node;
}

function treeRow(
  path: string,
  name: string,
  depth: number,
  isDir: boolean,
  isExpanded: boolean,
  readable: boolean
): HTMLElement {
  const row = document.createElement("div");
  row.className = "ft-row" + (!isDir && !readable ? " dim" : "");
  row.setAttribute("data-path", path);
  row.dataset.dir = isDir ? "1" : "0";
  row.style.paddingLeft = depth * 14 + 4 + "px";
  const arrow = document.createElement("span");
  arrow.className = "ft-arrow";
  arrow.textContent = isDir ? (isExpanded ? "▾" : "▸") : "";
  const ico = document.createElement("span");
  ico.className = "ft-ico";
  ico.textContent = isDir ? "📁" : readable ? "📄" : "▫";
  const nm = document.createElement("span");
  nm.className = "ft-name";
  nm.textContent = name;
  nm.title = name;
  const more = document.createElement("button");
  more.className = "ft-more";
  more.textContent = "⋯";
  more.title = "操作菜单";
  row.append(arrow, ico, nm, more);
  return row;
}

async function renderList(): Promise<void> {
  const box = $("folder-list");
  const keepScroll = box.scrollTop;
  box.innerHTML = "";
  if (!root) {
    $("folder-list-count").textContent = "";
    box.innerHTML = '<div class="kw-empty">尚未打开文件夹</div>';
    return;
  }
  const files = await collectFiles();
  const kw = filterText.trim().toLowerCase();
  const shown = kw ? files.filter((f) => f.name.toLowerCase().includes(kw)) : files;
  $("folder-list-count").textContent = `${shown.length.toLocaleString()} 个文件${files.length !== shown.length ? `（共 ${files.length.toLocaleString()}）` : ""}`;
  if (shown.length === 0) {
    box.innerHTML = '<div class="kw-empty">没有匹配的 TXT/ZIP 文件</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of shown) frag.appendChild(listRow(f));
  box.appendChild(frag);
  box.scrollTop = keepScroll;
}

function listRow(f: ListItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "fl-row";
  row.setAttribute("data-path", f.path);
  row.dataset.dir = "0";
  row.title = f.rel;
  const nm = document.createElement("span");
  nm.className = "fl-name";
  nm.textContent = f.rel;
  const meta = document.createElement("span");
  meta.className = "fl-meta";
  meta.textContent = `${fmtSize(f.size)} · ${fmtDate(f.mtime)}`;
  const more = document.createElement("button");
  more.className = "ft-more";
  more.textContent = "⋯";
  more.title = "操作菜单";
  row.append(nm, meta, more);
  return row;
}

function rowByPath(path: string): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>("#folder-tree .ft-row, #folder-list .fl-row");
  for (const r of Array.from(rows)) {
    if (r.getAttribute("data-path") === path) return r;
  }
  return null;
}

/* ========== 操作菜单 ========== */

function menuFor(
  targetPath: string,
  isDir: boolean,
  name: string,
  isRoot: boolean,
  x: number,
  y: number
): void {
  const items: MenuItemDef[] = [];
  if (!isDir && canOpenFile(name)) {
    items.push({ label: "打开", action: () => app.openPath(targetPath) });
  }
  items.push({ label: "新建文件夹", action: () => startMkdir(isDir ? targetPath : root) });
  if (!isRoot) {
    items.push({ label: "重命名", action: () => startRename(targetPath, name) });
  }
  if (!isDir) {
    items.push({ label: "移动到…（归档）", action: () => moveToDir(targetPath) });
  }
  if (!isRoot) {
    items.push({ sep: true });
    items.push({
      label: "删除（进回收站）",
      action: () => confirmDelete(targetPath, name, x, y),
    });
  }
  showDropdown(items, x, y);
}

/** 删除两段式确认：二级菜单里再点一次「删除」才真正执行 */
function confirmDelete(path: string, name: string, x: number, y: number): void {
  showDropdown(
    [
      { label: `确认删除「${name}」？（进回收站，可恢复）`, disabled: true },
      {
        label: "删除",
        action: async () => {
          try {
            const isCurrent = app.state.filePath === path || app.state.realPath === path;
            // 删除前记录列表顺序：删除的是当前阅读文件时，用来接续下一个
            const orderBefore = [...document.querySelectorAll("#folder-list .fl-row")].map((r) =>
              r.getAttribute("data-path")
            );
            await api.trashPath(path);
            app.toast(`已删除「${name}」${isCurrent ? "（正在阅读，自动接续下一个文件）" : ""}`);
            await refresh();
            if (isCurrent) await openNextAfterDeletion(path, orderBefore);
          } catch (e) {
            app.showMessage("删除失败", String(e));
          }
        },
      },
      { label: "取消", action: () => {} },
    ],
    x,
    y
  );
}

/** 删除的是当前阅读的文件：自动打开列表中它原位置的下一个文件，保持阅读连续 */
async function openNextAfterDeletion(deletedPath: string, orderBefore: (string | null)[]): Promise<void> {
  const after = [...document.querySelectorAll("#folder-list .fl-row")].map((r) =>
    r.getAttribute("data-path")
  );
  if (after.length === 0) {
    app.toast("文件夹中已没有可打开的文件");
    return;
  }
  const idx = orderBefore.indexOf(deletedPath);
  const nextPath = after[Math.min(Math.max(idx, 0), after.length - 1)];
  if (nextPath) await app.openPath(nextPath, { tab: "replace" }); // 阅读连续性：当前 tab 接续，不新开
}

async function moveToDir(path: string): Promise<void> {
  const toDir = await api.pickDirectory();
  if (!toDir) return;
  try {
    await api.moveTo(path, toDir);
    app.toast(`已归档到「${pathToName(toDir)}」`);
    await refresh();
  } catch (e) {
    app.showMessage("移动失败", String(e));
  }
}

/* ========== 行内重命名 / 新建文件夹 ========== */

function startRename(path: string, oldName: string): void {
  const row = rowByPath(path);
  const nameEl = row?.querySelector(".ft-name, .fl-name") as HTMLElement | null;
  if (!nameEl || nameEl.querySelector("input")) return;
  const input = document.createElement("input");
  input.className = "ft-rename-input";
  input.value = oldName;
  input.maxLength = 100;
  nameEl.textContent = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!save || !newName || newName === oldName) {
      void refresh(); // 还原显示
      return;
    }
    void (async () => {
      try {
        await api.renamePath(path, newName);
        app.toast(`已重命名为「${newName}」`);
      } catch (e) {
        app.showMessage("重命名失败", String(e));
      }
      await refresh();
    })();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 防止全局快捷键（Esc 关面板等）打断
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function startMkdir(dirPath: string): Promise<void> {
  expanded.add(dirPath);
  await renderTree();
  const node = nodeRows.get(dirPath);
  if (!node) return;
  const kids = node.querySelector(":scope > .ft-kids") as HTMLElement | null;
  const row = document.createElement("div");
  row.className = "ft-row ft-mkdir";
  row.style.paddingLeft = 18 + "px";
  const input = document.createElement("input");
  input.className = "ft-rename-input";
  input.value = "新建文件夹";
  input.maxLength = 100;
  row.appendChild(input);
  if (kids) kids.insertBefore(row, kids.firstChild);
  else node.appendChild(row);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!save || !name) {
      void renderTree();
      return;
    }
    void (async () => {
      try {
        await api.makeDir(dirPath, name);
        app.toast(`已创建「${name}」`);
      } catch (e) {
        app.showMessage("创建失败", String(e));
      }
      await refresh();
    })();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** 插件启停、排序开关等变化后刷新面板（面板未打开时只清缓存不重渲染） */
export async function refreshPanel(): Promise<void> {
  childrenCache.clear(); // 侧栏未开也要清：开关切换后重开面板不能命中旧序缓存
  if (!open) return;
  await refresh();
}

/* ========== 交互事件 ========== */

function showMenuForRow(row: HTMLElement, x: number, y: number): void {
  const path = row.getAttribute("data-path") || "";
  const isDir = row.dataset.dir === "1";
  const isRoot = path === root;
  menuFor(path, isDir, pathToName(path), isRoot, x, y);
}

function bindRowEvents(container: HTMLElement): void {
  container.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest(".ft-row, .fl-row") as HTMLElement | null;
    if (!row) return;
    const path = row.getAttribute("data-path") || "";
    if (t.closest(".ft-more")) {
      const r = row.getBoundingClientRect();
      showMenuForRow(row, r.left + 8, r.bottom + 4);
      return;
    }
    if (container.id === "folder-tree") {
      if (row.dataset.dir === "1") {
        if (expanded.has(path)) expanded.delete(path);
        else expanded.add(path);
        void renderTree();
      } else if (canOpenFile(path)) {
        void app.openPath(path);
      }
    } else {
      void app.openPath(path);
    }
  });
  container.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest(".ft-row, .fl-row") as HTMLElement | null;
    if (!row) return;
    showMenuForRow(row, e.clientX, e.clientY);
  });
}

export function initFolderPanel(): void {
  initPanelResize(panelEl(), "left");
  $("lptab-local").addEventListener("click", () => void switchSideTab("local"));
  $("lptab-smb").addEventListener("click", () => void switchSideTab("smb"));
  $("folder-pick").addEventListener("click", () => void pickFolder());
  $("folder-refresh").addEventListener("click", () => void refresh());
  $("folder-recursive").addEventListener("change", () => {
    listRecursive = ($("folder-recursive") as HTMLInputElement).checked;
    app.state.store.settings.folderListRecursive = listRecursive;
    app.persist();
    void renderList();
  });
  $("folder-filter").addEventListener("input", () => {
    filterText = ($("folder-filter") as HTMLInputElement).value;
    void renderList();
  });
  panelEl().querySelector(".panel-close")?.addEventListener("click", closeFolderPanel);
  bindRowEvents($("folder-tree"));
  bindRowEvents($("folder-list"));
  document.addEventListener("rb-escape", () => closeFolderPanel());
}
