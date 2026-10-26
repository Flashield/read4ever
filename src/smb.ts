/* 左侧面板「远程」标签：SMB 服务器树 + 目录文件列表。
   只读浏览 + 打开（openPath 直通后端 smb:// 分发，无新打开代码）+ 显式「缓存到本地」。
   服务器配置存 store.smbServers，增删改后推 smbPutServers 供后端重建会话。
   远程侧不提供删除/重命名/移动等破坏性操作。 */
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
  try {
    const entries = await api.smbListDir(dir);
    childrenCache.set(dir, entries);
    return entries;
  } catch (e) {
    app.toast(String(e).slice(0, 60));
    childrenCache.set(dir, []);
    return [];
  }
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

async function refreshDir(dir: string): Promise<void> {
  childrenCache.delete(dir);
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
    childrenCache.delete(parentDir(path));
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
                  childrenCache.delete(`smb://${s.id}`);
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

function menuForDir(path: string, x: number, y: number): void {
  showDropdown(
    [
      { label: "在下方列出文件", action: () => void selectDir(path) },
      { label: "刷新目录", action: () => void refreshDir(path) },
    ],
    x,
    y
  );
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
  showDropdown(items, x, y);
}

function entryByPath(path: string): SmbFileEntry | null {
  const dir = parentDir(path);
  const entries = childrenCache.get(dir);
  return entries?.find((x) => x.path === path) ?? null;
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
