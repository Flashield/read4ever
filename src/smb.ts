/* 左侧面板「远程」标签：SMB 服务器树 + 目录文件列表。
   只读浏览 + 打开（openPath 直通后端 smb:// 分发，无新打开代码）+ 显式「缓存到本地」。
   服务器配置存 store.smbServers，增删改后推 smbPutServers 供后端重建会话。
   远程写操作（删除/重命名/移动/新建文件夹）自 2026-10-29 起提供，删除为永久操作。 */
import { api } from "./api";
import * as app from "./app";
import { showDropdown, type MenuItemDef } from "./dropdown";
import { canOpenFile } from "./plugins/registry";
import type { SmbFileEntry, SmbServer } from "./types";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let expanded = new Set<string>(); // 已展开的 smb:// 目录（含服务器根 smb://<id>）
let selectedDir = ""; // 文件列表当前展示的目录
let filterText = "";
let renderedOnce = false;
let cacheBusy = false; // 「缓存到本地」进行中（同一时间只允许一个）
const childrenCache = new Map<string, SmbFileEntry[]>();
const nodeRows = new Map<string, HTMLElement>();

const servers = (): SmbServer[] => app.state.store.smbServers;

/* ========== 数据 ========== */

async function loadChildren(dir: string): Promise<SmbFileEntry[]> {
  const cached = childrenCache.get(dir);
  if (cached) return cached;
  let entries: SmbFileEntry[];
  try {
    entries = await api.smbListDir(dir, app.state.store.settings.naturalSort);
  } catch (e) {
    app.toast(String(e).slice(0, 60));
    childrenCache.set(dir, []);
    return [];
  }
  childrenCache.set(dir, entries);
  // 服务器根别名 smb://<id> 与规范共享根 smb://<id>/<share> 指向同一目录：
  // 双写缓存键，否则共享根直接子文件的右键菜单（entryByPath 按规范父目录查）会落空
  const segs = dir.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length >= 2 && segs[0] === "smb:") {
    const srv = servers().find((s) => s.id === segs[1]);
    if (srv) {
      const canon = `smb://${srv.id}/${srv.share}`;
      const alias = `smb://${srv.id}`;
      if (dir === canon || dir === alias) {
        childrenCache.set(canon, entries);
        childrenCache.set(alias, entries);
      }
    }
  }
  return entries;
}

function pathToName(p: string): string {
  return p.split("/").filter(Boolean).pop() || p;
}

/** 目录的直接父目录（smb://a/b/c → smb://a/b；根则原样） */
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > "smb://".length ? p.slice(0, i) : p;
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
  const list = servers();
  $("smb-status").textContent =
    list.length === 0 ? "未添加服务器" : `${list.length} 台服务器`;
  await renderTree();
  await renderList();
}

/** 排序开关切换后全量刷新：列表缓存里的条目是按旧开关排好的，先清再渲染 */
export async function refreshAll(): Promise<void> {
  childrenCache.clear();
  await renderAll();
}

async function renderTree(): Promise<void> {
  const box = $("smb-tree");
  const keepScroll = box.scrollTop;
  box.innerHTML = "";
  nodeRows.clear();
  const list = servers();
  if (list.length === 0) {
    box.innerHTML = '<div class="kw-empty">点击上方「＋ 服务器」添加 Samba/NAS 共享</div>';
    return;
  }
  for (const s of list) {
    box.appendChild(await buildServerNode(s));
  }
  box.scrollTop = keepScroll;
}

async function buildServerNode(s: SmbServer): Promise<HTMLElement> {
  const rootPath = `smb://${s.id}`;
  const node = document.createElement("div");
  node.className = "ft-node";
  node.appendChild(serverRow(s, expanded.has(rootPath)));
  nodeRows.set(rootPath, node);
  if (expanded.has(rootPath)) {
    const kids = document.createElement("div");
    kids.className = "ft-kids";
    const entries = await loadChildren(rootPath);
    for (const e of entries) {
      if (e.isDir) {
        kids.appendChild(await buildDirNode(e.path, e.name, 1));
      } else {
        kids.appendChild(treeFileRow(e, 1));
      }
    }
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ft-emptyline";
      empty.style.paddingLeft = 1 * 14 + 30 + "px";
      empty.textContent = "（空）";
      kids.appendChild(empty);
    }
    node.appendChild(kids);
  }
  return node;
}

async function buildDirNode(dirPath: string, name: string, depth: number): Promise<HTMLElement> {
  const node = document.createElement("div");
  node.className = "ft-node";
  node.appendChild(dirRow(dirPath, name, depth, expanded.has(dirPath)));
  nodeRows.set(dirPath, node);
  if (expanded.has(dirPath)) {
    const kids = document.createElement("div");
    kids.className = "ft-kids";
    const entries = await loadChildren(dirPath);
    for (const e of entries) {
      if (e.isDir) {
        kids.appendChild(await buildDirNode(e.path, e.name, depth + 1));
      } else {
        kids.appendChild(treeFileRow(e, depth + 1));
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

function serverRow(s: SmbServer, isExpanded: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "ft-row smb-server";
  const rootPath = `smb://${s.id}`;
  row.setAttribute("data-path", rootPath);
  row.dataset.dir = "1";
  row.dataset.server = s.id;
  row.style.paddingLeft = "4px";
  const arrow = document.createElement("span");
  arrow.className = "ft-arrow";
  arrow.textContent = isExpanded ? "▾" : "▸";
  const ico = document.createElement("span");
  ico.className = "ft-ico";
  ico.textContent = "🖥";
  const nm = document.createElement("span");
  nm.className = "ft-name";
  nm.textContent = s.name;
  nm.title = `${s.name}（${s.host}/${s.share}）`;
  const more = document.createElement("button");
  more.className = "ft-more";
  more.textContent = "⋯";
  more.title = "服务器操作";
  row.append(arrow, ico, nm, more);
  return row;
}

function dirRow(path: string, name: string, depth: number, isExpanded: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "ft-row";
  row.setAttribute("data-path", path);
  row.dataset.dir = "1";
  row.style.paddingLeft = depth * 14 + 4 + "px";
  const arrow = document.createElement("span");
  arrow.className = "ft-arrow";
  arrow.textContent = isExpanded ? "▾" : "▸";
  const ico = document.createElement("span");
  ico.className = "ft-ico";
  ico.textContent = "📁";
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

function treeFileRow(e: SmbFileEntry, depth: number): HTMLElement {
  const readable = canOpenFile(e.name);
  const row = document.createElement("div");
  row.className = "ft-row" + (!readable ? " dim" : "");
  row.setAttribute("data-path", e.path);
  row.dataset.dir = "0";
  row.style.paddingLeft = depth * 14 + 4 + "px";
  const arrow = document.createElement("span");
  arrow.className = "ft-arrow";
  const ico = document.createElement("span");
  ico.className = "ft-ico";
  ico.textContent = readable ? "📄" : "▫";
  const nm = document.createElement("span");
  nm.className = "ft-name";
  nm.textContent = e.name;
  nm.title = e.name;
  row.append(arrow, ico, nm);
  if (e.cached) {
    const badge = document.createElement("span");
    badge.className = "smb-cached-badge";
    badge.textContent = "✔";
    badge.title = "已缓存到本地";
    row.appendChild(badge);
  }
  const more = document.createElement("button");
  more.className = "ft-more";
  more.textContent = "⋯";
  more.title = "操作菜单";
  row.appendChild(more);
  return row;
}

async function renderList(): Promise<void> {
  const box = $("smb-list");
  const keepScroll = box.scrollTop;
  box.innerHTML = "";
  if (!selectedDir) {
    $("smb-list-count").textContent = "";
    box.innerHTML = '<div class="kw-empty">点击树中的目录，在下方列出其中的文件</div>';
    return;
  }
  const entries = await loadChildren(selectedDir);
  const files = entries.filter((e) => !e.isDir);
  const kw = filterText.trim().toLowerCase();
  const shown = kw ? files.filter((f) => f.name.toLowerCase().includes(kw)) : files;
  $("smb-list-count").textContent =
    `${shown.length.toLocaleString()} 个文件` +
    (files.length !== shown.length ? `（共 ${files.length.toLocaleString()}）` : "");
  if (shown.length === 0) {
    box.innerHTML = '<div class="kw-empty">没有文件</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of shown) frag.appendChild(listRow(f));
  box.appendChild(frag);
  box.scrollTop = keepScroll;
}

function listRow(f: SmbFileEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "fl-row";
  row.setAttribute("data-path", f.path);
  row.dataset.dir = "0";
  row.title = f.path;
  const nm = document.createElement("span");
  nm.className = "fl-name";
  nm.textContent = f.name;
  const meta = document.createElement("span");
  meta.className = "fl-meta";
  meta.textContent = `${fmtSize(f.size)} · ${fmtDate(f.mtime)}`;
  row.append(nm, meta);
  if (f.cached) {
    const badge = document.createElement("span");
    badge.className = "smb-cached-badge";
    badge.textContent = "✔";
    badge.title = "已缓存到本地";
    row.appendChild(badge);
  }
  const more = document.createElement("button");
  more.className = "ft-more";
  more.textContent = "⋯";
  more.title = "操作菜单";
  row.appendChild(more);
  return row;
}

function rowByPath(path: string): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>("#smb-tree .ft-row, #smb-list .fl-row");
  for (const r of Array.from(rows)) {
    if (r.getAttribute("data-path") === path) return r;
  }
  return null;
}

/* ========== 操作 ========== */

/** 失效某目录的列表缓存（服务器根别名与规范共享根双键一起删；
 *  传入服务器根 smb://<id> 时连其子目录键一并清扫，供删除服务器后调用） */
function dropDirCache(dir: string): void {
  childrenCache.delete(dir);
  const segs = dir.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length < 2 || segs[0] !== "smb:") return;
  const srv = servers().find((s) => s.id === segs[1]);
  if (srv) {
    childrenCache.delete(`smb://${srv.id}/${srv.share}`);
    childrenCache.delete(`smb://${srv.id}`);
  }
  if (segs.length === 2) {
    // dir 形如 smb://<id>：不依赖 servers()（删除流程先改表后清缓存），直接按键前缀清扫
    for (const k of [...childrenCache.keys()]) {
      if (k.startsWith(`${dir}/`)) childrenCache.delete(k);
    }
  }
}

async function refreshDir(dir: string): Promise<void> {
  dropDirCache(dir);
  await renderAll();
}

/** 「缓存到本地」（或缓存过期时「更新缓存」） */
async function cacheFile(path: string, name: string): Promise<void> {
  if (cacheBusy) {
    app.toast("已有下载任务进行中，请稍候");
    return;
  }
  cacheBusy = true;
  app.toast(`正在缓存「${name}」…`);
  try {
    await api.smbCacheFile(path);
    app.toast(`已缓存「${name}」`);
    dropDirCache(parentDir(path));
    await renderAll();
  } catch (e) {
    app.showMessage("缓存失败", String(e));
  } finally {
    cacheBusy = false;
  }
}

async function clearAllCache(): Promise<void> {
  try {
    const freed = await api.smbClearCache();
    app.toast(`已清空远程缓存（释放 ${fmtSize(freed)}）`);
    childrenCache.clear();
    await renderAll();
  } catch (e) {
    app.showMessage("清空缓存失败", String(e));
  }
}

/* ========== 菜单 ========== */

function menuForServer(s: SmbServer, x: number, y: number): void {
  showDropdown(
    [
      {
        label: "测试连接",
        action: async () => {
          try {
            const info = await api.smbTest(s);
            app.toast(`连接成功：${info}`);
          } catch (e) {
            app.showMessage("连接失败", String(e));
          }
        },
      },
      { label: "编辑…", action: () => void editServer(s) },
      { sep: true },
      { label: `删除「${s.name}」（二级确认）`, disabled: true },
      {
        label: "删除服务器",
        action: () =>
          showDropdown(
            [
              { label: `确认删除「${s.name}」？（不影响已保存的历史/书架条目）`, disabled: true },
              {
                label: "删除",
                action: async () => {
                  const list = servers().filter((x) => x.id !== s.id);
                  await pushServers(list);
                  dropDirCache(`smb://${s.id}`);
                  expanded.delete(`smb://${s.id}`);
                  app.toast(`已删除「${s.name}」`);
                  await renderAll();
                },
              },
              { label: "取消", action: () => {} },
            ],
            x,
            y
          ),
      },
      { sep: true },
      { label: "清空全部本地缓存", action: () => void clearAllCache() },
    ],
    x,
    y
  );
}

/** 共享根判定：smb://<id>（服务器根别名）与 smb://<id>/<share>（规范共享根）都不可重命名/移动/删除 */
function isShareRoot(path: string): boolean {
  const segs = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return segs[0] === "smb:" && segs.length <= 3;
}

function menuForDir(path: string, x: number, y: number): void {
  const items: MenuItemDef[] = [
    { label: "在下方列出文件", action: () => void selectDir(path) },
    { label: "刷新目录", action: () => void refreshDir(path) },
    { label: "新建文件夹", action: () => void startMkdir(path) },
  ];
  if (!isShareRoot(path)) {
    items.push({ label: "重命名", action: () => startRename(path, pathToName(path)) });
    items.push({ label: "移动到…", action: () => moveToDir(path, pathToName(path)) });
    items.push({ sep: true });
    items.push({ label: "删除", action: () => confirmDelete(path, pathToName(path), x, y) });
  }
  showDropdown(items, x, y);
}

function menuForFile(e: SmbFileEntry, x: number, y: number): void {
  const items: MenuItemDef[] = [];
  if (canOpenFile(e.name)) {
    items.push({ label: "打开", action: () => void app.openPath(e.path) });
  }
  items.push({
    label: e.cached ? "更新缓存" : "缓存到本地",
    action: () => void cacheFile(e.path, e.name),
  });
  items.push({ label: "重命名", action: () => startRename(e.path, e.name) });
  items.push({ label: "移动到…", action: () => moveToDir(e.path, e.name) });
  items.push({ sep: true });
  items.push({ label: "删除", action: () => confirmDelete(e.path, e.name, x, y) });
  showDropdown(items, x, y);
}

function entryByPath(path: string): SmbFileEntry | null {
  const dir = parentDir(path);
  const entries = childrenCache.get(dir);
  return entries?.find((x) => x.path === path) ?? null;
}

/* ========== 远程写操作（删除为永久操作，无回收站） ========== */

/** 行内重命名：名字元素原地换输入框，Enter/失焦提交，Esc 还原（交互同 folder.ts） */
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
      void refreshDir(parentDir(path) || path); // 还原显示
      return;
    }
    void (async () => {
      try {
        await api.smbRename(path, newName);
        app.toast(`已重命名为「${newName}」`);
        // 旧路径子树缓存残留会让同名重建目录命中旧数据，照 confirmDelete 清扫
        for (const k of [...childrenCache.keys()]) {
          if (k === path || k.startsWith(path + "/")) childrenCache.delete(k);
        }
        for (const k of [...expanded]) {
          if (k === path || k.startsWith(path + "/")) expanded.delete(k);
        }
      } catch (e) {
        app.showMessage("重命名失败", String(e));
      }
      await refreshDir(parentDir(path) || path);
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

/** 新建文件夹：目标目录树节点下插入行内输入行（节点未展开先展开），交互同 folder.ts */
async function startMkdir(dir: string): Promise<void> {
  expanded.add(dir);
  await renderTree();
  const node = nodeRows.get(dir);
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
      void renderTree(); // 还原
      return;
    }
    void (async () => {
      try {
        await api.smbMkdir(dir, name);
        app.toast(`已创建「${name}」`);
      } catch (e) {
        app.showMessage("创建失败", String(e));
      }
      await refreshDir(dir);
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

/** 删除两段式确认：二级菜单里再点一次「删除」才真正执行。SMB 无回收站，删除不可恢复 */
function confirmDelete(path: string, name: string, x: number, y: number): void {
  showDropdown(
    [
      { label: `确认永久删除「${name}」？（无回收站，不可恢复）`, disabled: true },
      {
        label: "删除",
        action: async () => {
          try {
            const isCurrent = app.state.realPath === path || app.state.filePath === path;
            // 删除前记录列表顺序：删除的是当前阅读文件时，用来接续下一个
            const orderBefore = [...document.querySelectorAll("#smb-list .fl-row")].map((r) =>
              r.getAttribute("data-path")
            );
            await api.smbDelete(path);
            app.toast(`已删除「${name}」`);
            const parent = parentDir(path);
            if (parent && parent !== path) {
              dropDirCache(parent);
              // 被删目录可能已展开/在列表缓存中：一并失效
              for (const k of [...childrenCache.keys()]) {
                if (k === path || k.startsWith(path + "/")) childrenCache.delete(k);
              }
              for (const k of [...expanded]) {
                if (k === path || k.startsWith(path + "/")) expanded.delete(k);
              }
              // 下方列表正展示被删目录（或其子目录）时回退到父目录
              if (selectedDir === path || selectedDir.startsWith(path + "/")) selectedDir = parent;
            }
            await renderAll();
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

/** 删除的是正在阅读的文件：自动打开列表中它原位置的下一个文件，保持阅读连续 */
async function openNextAfterDeletion(
  deletedPath: string,
  orderBefore: (string | null)[]
): Promise<void> {
  const after = [...document.querySelectorAll("#smb-list .fl-row")].map((r) =>
    r.getAttribute("data-path")
  );
  if (after.length === 0) {
    app.toast("目录中已没有可打开的文件");
    return;
  }
  const idx = orderBefore.indexOf(deletedPath);
  if (idx < 0) return; // 删除的文件不在当前下方列表：不开任意文件
  const nextPath = after[Math.min(Math.max(idx, 0), after.length - 1)];
  if (nextPath) {
    app.toast("已自动接续下一个文件");
    await app.openPath(nextPath);
  }
}

/** SMB 目录选择弹窗：浏览共享内目录选目标（本地走系统目录选择器，SMB 用不了） */
function pickSmbDir(
  startDir: string,
  selfPath: string,
  fromDir: string,
  onPick: (dir: string) => void
): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `
    <div class="modal-content">
      <div class="modal-header"><span>移动到…</span><button type="button">✕</button></div>
      <div class="dirpick-body" style="max-height:50vh;overflow:auto;padding:4px 0"></div>
      <div class="modal-footer">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        <button type="button" class="dirpick-ok msg-ok">移动到这里</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  const body = m.querySelector(".dirpick-body") as HTMLElement;
  const curLabel = m.querySelector(".modal-footer span") as HTMLElement;
  const okBtn = m.querySelector(".dirpick-ok") as HTMLButtonElement;
  let cur = startDir;
  let seq = 0; // render 重入守卫序号

  /** 目标落在被移动项自身或其子目录内时禁止确认（后端也拦，这里是交互层提示） */
  const isInsideSelf = (dir: string): boolean =>
    dir === selfPath || dir.startsWith(selfPath.replace(/\/+$/, "") + "/");
  const close = (): void => m.remove();
  m.querySelector(".modal-header button")?.addEventListener("click", close);
  m.addEventListener("mousedown", (e) => {
    if (e.target === m) close();
  });

  const render = async (): Promise<void> => {
    const my = ++seq; // 重入守卫：快速点目录时旧请求的子项不得 append 进新目录的 body
    curLabel.textContent = cur;
    okBtn.disabled = isInsideSelf(cur) || cur === fromDir;
    body.innerHTML = "";
    const up = parentDir(cur);
    if (up && up !== cur) {
      const r = document.createElement("div");
      r.textContent = "📁 ..（上级目录）";
      r.style.cssText = "padding:6px 10px;cursor:pointer";
      r.addEventListener("click", () => {
        cur = up;
        void render();
      });
      body.appendChild(r);
    }
    const entries = await loadChildren(cur);
    if (my !== seq) return; // 期间已切到别的目录，丢弃本次结果
    for (const e of entries) {
      if (!e.isDir) continue;
      const r = document.createElement("div");
      r.textContent = "📁 " + e.name;
      r.style.cssText = "padding:6px 10px;cursor:pointer";
      r.addEventListener("click", () => {
        cur = e.path;
        void render();
      });
      body.appendChild(r);
    }
  };
  okBtn.addEventListener("click", () => {
    close();
    onPick(cur);
  });
  void render();
}

function moveToDir(path: string, name: string): void {
  const from = parentDir(path);
  pickSmbDir(from || path, path, from || "", (to) => {
    void (async () => {
      try {
        await api.smbMove(path, to);
        app.toast(`已移动「${name}」到「${pathToName(to)}」`);
        // 旧路径子树缓存残留会让同名重建目录命中旧数据，照 confirmDelete 清扫
        for (const k of [...childrenCache.keys()]) {
          if (k === path || k.startsWith(path + "/")) childrenCache.delete(k);
        }
        for (const k of [...expanded]) {
          if (k === path || k.startsWith(path + "/")) expanded.delete(k);
        }
      } catch (e) {
        app.showMessage("移动失败", String(e));
        return;
      }
      dropDirCache(from);
      dropDirCache(to);
      await renderAll();
    })();
  });
}

/* ========== 服务器编辑弹窗 ========== */

/** 新建（无参）或编辑服务器配置；保存后 upsert + 推后端 + 重渲染 */
function editServer(existing?: SmbServer): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `
    <div class="modal-content">
      <div class="modal-header"><span></span><button type="button">✕</button></div>
      <form class="smb-form" id="smb-form">
        <label>名称<input name="name" maxlength="40" placeholder="如：家里 NAS" /></label>
        <label>主机（IP 或主机名，可带 :端口）<input name="host" placeholder="192.168.1.100" /></label>
        <label>共享名<input name="share" placeholder="books" /></label>
        <label>工作组（可选）<input name="workgroup" placeholder="WORKGROUP" /></label>
        <label class="smb-form-anon"><input type="checkbox" name="anon" /> 匿名（访客）访问</label>
        <label>用户名<input name="username" placeholder="访客模式留空" /></label>
        <label>密码<input name="password" type="password" /></label>
      </form>
      <div class="modal-footer">
        <button type="button" class="smb-test">测试连接</button>
        <button type="button" class="smb-cancel">取消</button>
        <button type="button" class="smb-save msg-ok">保存</button>
      </div>
    </div>`;
  const title = m.querySelector(".modal-header span") as HTMLElement;
  title.textContent = existing ? "编辑 SMB 服务器" : "添加 SMB 服务器";
  const form = m.querySelector("#smb-form") as HTMLFormElement;
  const f = form.elements as unknown as Record<
    "name" | "host" | "share" | "workgroup" | "username" | "password" | "anon",
    HTMLInputElement
  >;
  if (existing) {
    f.name.value = existing.name;
    f.host.value = existing.host;
    f.share.value = existing.share;
    f.workgroup.value = existing.workgroup;
    f.username.value = existing.username;
    f.password.value = existing.password;
    f.anon.checked = !existing.username;
  }
  const syncAnon = (): void => {
    const anon = f.anon.checked;
    f.username.disabled = anon;
    f.password.disabled = anon;
  };
  f.anon.addEventListener("change", syncAnon);
  syncAnon();

  const close = (): void => m.remove();
  m.querySelector(".modal-header button")?.addEventListener("click", close);
  m.querySelector(".smb-cancel")?.addEventListener("click", close);
  m.addEventListener("mousedown", (e) => {
    if (e.target === m) close();
  });

  /** 从当前表单收集配置（不落库） */
  const gather = (): SmbServer => ({
    id: existing?.id ?? crypto.randomUUID().slice(0, 8),
    name: f.name.value.trim(),
    host: f.host.value.trim(),
    share: f.share.value.trim().replace(/^[/\\]+|[/\\]+$/g, ""),
    workgroup: f.workgroup.value.trim(),
    username: f.anon.checked ? "" : f.username.value.trim(),
    password: f.anon.checked ? "" : f.password.value,
  });

  m.querySelector(".smb-test")?.addEventListener("click", () => {
    const cfg = gather();
    if (!cfg.host || !cfg.share) {
      app.toast("请先填写主机与共享名");
      return;
    }
    void (async () => {
      app.toast("正在测试连接…");
      try {
        const info = await api.smbTest(cfg);
        app.toast(`连接成功：${info}`);
      } catch (e) {
        app.showMessage("连接失败", String(e));
      }
    })();
  });

  m.querySelector(".smb-save")?.addEventListener("click", () => {
    const cfg = gather();
    if (!cfg.name || !cfg.host || !cfg.share) {
      app.toast("名称、主机、共享名均不能为空");
      return;
    }
    close();
    void (async () => {
      const list = servers().filter((x) => x.id !== cfg.id);
      list.push(cfg);
      await pushServers(list);
      expanded.add(`smb://${cfg.id}`);
      app.toast(existing ? `已更新「${cfg.name}」` : `已添加「${cfg.name}」`);
      await renderAll();
    })();
  });

  document.body.appendChild(m);
  f.name.focus();
}

/** 服务器表落库 + 推后端（后端据此重建/失效会话） */
async function pushServers(list: SmbServer[]): Promise<void> {
  app.state.store.smbServers = list;
  app.persist();
  await api.smbPutServers(list);
}

/* ========== 展开 / 定位 ========== */

async function selectDir(path: string): Promise<void> {
  selectedDir = path;
  await renderList();
}

/** 在远程树中定位文件：逐级展开祖先目录、列表切到所在目录、滚动高亮 */
export async function revealRemote(path: string): Promise<void> {
  const pure = path.split("::")[0];
  const segs = pure.replace(/^smb:\/*/, "").split("/").filter(Boolean);
  if (segs.length === 0) return;
  // 展开服务器根到文件所在目录
  const dirs: string[] = [];
  let acc = `smb://${segs[0]}`;
  dirs.push(acc);
  for (let i = 1; i < segs.length - 1; i++) {
    acc += "/" + segs[i];
    dirs.push(acc);
  }
  for (const d of dirs) expanded.add(d);
  selectedDir = dirs[dirs.length - 1];
  childrenCache.clear();
  await renderAll();
  const row = rowByPath(pure);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.classList.add("located");
    window.setTimeout(() => row.classList.remove("located"), 2000);
  }
}

/** 标签页切到远程时渲染（首切后为轻量 no-op） */
export async function ensureRendered(): Promise<void> {
  if (renderedOnce) return;
  renderedOnce = true;
  await renderAll();
}

/* ========== 交互事件 ========== */

function showMenuForRow(row: HTMLElement, x: number, y: number): void {
  const path = row.getAttribute("data-path") || "";
  if (row.dataset.server) {
    const s = servers().find((v) => v.id === row.dataset.server);
    if (s) menuForServer(s, x, y);
    return;
  }
  if (row.dataset.dir === "1") {
    menuForDir(path, x, y);
    return;
  }
  const e = entryByPath(path);
  if (e) menuForFile(e, x, y);
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
    if (row.dataset.dir === "1") {
      // 服务器根/目录：切换展开；目录同时把下方列表切到该目录
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      if (!row.dataset.server) selectedDir = path;
      void renderAll();
      return;
    }
    if (canOpenFile(pathToName(path))) {
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

export function initSmbPanel(): void {
  $("smb-add").addEventListener("click", () => editServer());
  $("smb-refresh").addEventListener("click", () => {
    childrenCache.clear();
    void renderAll();
  });
  $("smb-filter").addEventListener("input", () => {
    filterText = ($("smb-filter") as HTMLInputElement).value;
    void renderList();
  });
  bindRowEvents($("smb-tree"));
  bindRowEvents($("smb-list"));
}
