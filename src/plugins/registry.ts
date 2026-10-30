/* 插件注册表与中央打开管线：按扩展名路由到启用的插件。
   内置插件由 boot 编译期注册；外部插件（.rbplugin 包）由 loader 动态注册，
   两者共用 ReadBookPlugin 接口，本模块不做区分。 */
import { api } from "../api";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as app from "../app";
import { holdAwake, releaseAwake } from "../keepawake";
import * as mediaDock from "../mediaDock";
import type { MenuItemDef } from "../dropdown";
import type { FileEntry, PluginPkgInfo } from "../types";
import type { PluginOpenContext, PluginViewInstance, PluginViewStatus, ReadBookPlugin } from "./types";

const TEXT_RE = /\.(txt|zip)$/i;

/** 流式播放协议（src-tauri/src/stream.rs）：按 HTTP Range 分块响应本地文件、本地 zip 存储型条目与 SMB 远程普通文件 */
const STREAM_SCHEME = "readbook-stream";

/** 真 Tauri 环境判定：mock_backend 会伪造 __TAURI_INTERNALS__（仅供 invoke），
 *  但没有真运行时注入的 convertFileSrc——以它为准 */
const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  typeof (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } })
    .__TAURI_INTERNALS__?.convertFileSrc === "function";

/** 远程 smb 复合路径（zip::条目）：协议侧显式 404，不发起必败的流式尝试 */
const isSmbComposite = (p: string): boolean => p.startsWith("smb://") && p.includes("::");

/** 本地文件与 SMB 远程普通文件的流式播放 URL；远程 zip 条目与浏览器演示环境返回 null（回退字节整读）。
 *  zip 条目保持「zip路径::条目名」复合形式整体编码，协议侧自行拆分。
 *  注意 splitTarget 的 base 在 zip 复合路径下是条目名，smb:// 前缀在 zipPath 里。 */
function streamUrlFor(path: string): string | null {
  if (!isTauri()) return null;
  if (isSmbComposite(path)) return null;
  const t = splitTarget(path);
  const target = t.entry ? `${t.zipPath}::${t.entry}` : t.base;
  return convertFileSrc(target, STREAM_SCHEME);
}

const plugins: ReadBookPlugin[] = [];
/** 外部插件 id → 包信息（内置插件不在此列） */
const externalPkgs = new Map<string, PluginPkgInfo>();

/** 外部插件加载失败记录（插件管理面板展示） */
export interface PluginLoadError {
  id: string;
  name: string;
  version: string;
  error: string;
}
let loadErrors: PluginLoadError[] = [];

/** 插件 id → 是否启用；未列出的默认启用 */
let enabledMap: Record<string, boolean> = {};

/** 插件视图实例表：多标签页下每个 tab 可持有一个视图（Task 3 接管生命周期归属） */
export interface ViewEntry {
  id: string; // 实例 id（常亮来源 view:<id> / 媒体坞会话 id）
  plugin: ReadBookPlugin;
  inst: PluginViewInstance;
  pane: HTMLElement; // .plugin-view-pane，宿主于 #plugin-view-host
  status: PluginViewStatus;
  file: string; // 当前查看的文件名（zip 条目为条目名）
  openedName: string; // 打开的文件名（zip 内条目为 zip 自身文件名）
  ctxPath: string; // 当前文件路径（插件跨容器推进随之变化）
  scopeZip: string;
  scopeDir: string;
}

const views = new Map<string, ViewEntry>();
let curActiveViewId = "";

export function activeEntry(): ViewEntry | null {
  return views.get(curActiveViewId) ?? null;
}
export function activeViewId(): string {
  return curActiveViewId;
}
export function instanceOf(id: string): PluginViewInstance | null {
  return views.get(id)?.inst ?? null;
}
export function viewPath(id: string): string {
  return views.get(id)?.ctxPath ?? "";
}
export function pluginIdOfView(id: string): string {
  return views.get(id)?.plugin.id ?? "";
}

/** 全部插件视图实例暂停播放（进入托盘时调用；含激活实例，恢复显示后保持暂停）。
 *  通道与切标签页播放策略 tabs.applyPlaybackPolicy 一致，范围扩大到全部实例。 */
export function pauseAllInstances(): void {
  for (const e of views.values()) {
    if (e.plugin.backgroundPlayback) continue; // 后台播放豁免(音频):托盘不暂停
    try {
      if (e.inst.isPlaying?.()) e.inst.togglePlay?.();
    } catch {
      /* 忽略：单个实例异常不阻断其余 */
    }
  }
}

/** 该视图实例是否豁免后台暂停策略(tabs.applyPlaybackPolicy 切标签页时用) */
export function viewAllowsBackground(id: string): boolean {
  return views.get(id)?.plugin.backgroundPlayback === true;
}

export function register(p: ReadBookPlugin, pkg?: PluginPkgInfo): boolean {
  if (plugins.some((x) => x.id === p.id)) return false;
  plugins.push(p);
  if (pkg) externalPkgs.set(p.id, pkg);
  return true;
}

/** 移除插件注册（外部插件卸载时）；停用插件销毁其全部实例 */
export function unregister(id: string): boolean {
  const i = plugins.findIndex((x) => x.id === id);
  if (i === -1) return false;
  for (const v of [...views.values()]) {
    if (v.plugin.id === id) closeView(v.id);
  }
  plugins.splice(i, 1);
  externalPkgs.delete(id);
  return true;
}

export function list(): ReadBookPlugin[] {
  return [...plugins];
}

export const isExternal = (id: string): boolean => externalPkgs.has(id);
export const externalPkg = (id: string): PluginPkgInfo | undefined => externalPkgs.get(id);

export function setLoadErrors(errs: PluginLoadError[]): void {
  loadErrors = errs;
}

export function setEnabledMap(map: Record<string, boolean> | undefined): void {
  enabledMap = map ?? {};
}

export function isEnabled(p: ReadBookPlugin): boolean {
  return enabledMap[p.id] !== false;
}

export const extOf = (name: string): string => {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
};

export function handlerForExt(ext: string): ReadBookPlugin | null {
  if (!ext) return null;
  return plugins.find((p) => isEnabled(p) && p.extensions.includes(ext)) ?? null;
}

/** 该文件名是否可打开：txt/zip 恒可，其余看启用的插件 */
export function canOpenFile(name: string): boolean {
  if (TEXT_RE.test(name)) return true;
  return !!handlerForExt(extOf(name));
}

/** 当前启用插件声明的全部扩展名（文件对话框过滤器用，形如 "png"） */
export function pluginExts(): string[] {
  const out: string[] = [];
  for (const p of plugins) {
    if (isEnabled(p)) out.push(...p.extensions.map((e) => e.replace(/^\./, "")));
  }
  return out;
}

/* ========== 插件视图状态（右上角文件名/状态栏的上报与查询） ========== */

export function isActive(): boolean {
  return curActiveViewId !== "";
}

export function getActiveStatus(): PluginViewStatus | null {
  return activeEntry()?.status ?? null;
}

/** 激活插件视图期间右上角显示的文件名（未上报 title 时的兜底） */
export function getActiveFile(): string {
  return activeEntry()?.file ?? "";
}

/** 插件视图打开的文件名（zip 内条目为 zip 自身文件名；未上报 title 时的兜底） */
export function getActiveOpenedName(): string {
  return activeEntry()?.openedName ?? "";
}

/** 插件视图当前查看的文件路径（跨容器推进后随之变化；未激活为 ""）。收藏书架等以它为准 */
export function activeFilePath(): string {
  return activeEntry()?.ctxPath ?? "";
}

/** 当前激活插件（未激活为 null）：宿主「滚屏/播放」「上一个/下一个文件」公共入口按它分发 */
export function activePlugin(): ReadBookPlugin | null {
  return activeEntry()?.plugin ?? null;
}

/** 激活视图实例：宿主「滚屏/播放」「上一个/下一个」公共入口按它分发 */
export function activeInstance(): PluginViewInstance | null {
  return activeEntry()?.inst ?? null;
}

function splitTarget(path: string): { zipPath: string; entry: string; base: string } {
  const m = path.match(/^(.+\.zip)::(.+)$/i);
  if (m) return { zipPath: m[1], entry: m[2], base: m[2] };
  return { zipPath: "", entry: "", base: path };
}

const parentOf = (p: string): string => {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
};

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** 实例作用域（scopeZip/scopeDir 迁入 entry）——ctx.loadBytes/listContainer 的安全边界 */
function inScope(e: ViewEntry, path: string): boolean {
  const t = splitTarget(path);
  if (t.entry) return t.zipPath === e.scopeZip;
  if (e.scopeZip) return false; // 打开的是 zip 条目：不允许借道读外部磁盘文件
  return parentOf(t.base) === e.scopeDir;
}

async function loadBytesIn(e: ViewEntry, path: string): Promise<Uint8Array> {
  if (!inScope(e, path)) throw new Error(`插件只能访问当前文件所在目录/压缩包内的文件: ${path}`);
  const { zipPath, entry } = splitTarget(path);
  const buf = entry
    ? await api.readZipBytes(zipPath, entry)
    : await api.readFileBytes(path);
  return new Uint8Array(buf);
}

async function listContainerIn(e: ViewEntry): Promise<string[]> {
  try {
    if (e.scopeZip) return api.listZip(e.scopeZip, app.state.store.settings.naturalSort);
    const entries: FileEntry[] = await api.listDir(e.scopeDir, app.state.store.settings.naturalSort);
    return entries.filter((x) => !x.isDir).map((x) => x.path);
  } catch {
    return [];
  }
}

async function computeSiblings(path: string, ext: string): Promise<{ siblings: string[]; index: number }> {
  const { zipPath, entry, base } = splitTarget(path);
  try {
    if (entry) {
      const all = await api.listZip(zipPath, app.state.store.settings.naturalSort);
      const sibs = all.filter((n) => extOf(n) === ext).map((n) => `${zipPath}::${n}`);
      return { siblings: sibs, index: Math.max(0, sibs.indexOf(path)) };
    }
    const sep = base.includes("\\") ? "\\" : "/";
    const dir = base.slice(0, Math.max(base.lastIndexOf(sep), 0));
    const entries: FileEntry[] = await api.listDir(dir, app.state.store.settings.naturalSort);
    const sibs = entries.filter((e) => !e.isDir && extOf(e.name) === ext).map((e) => e.path);
    return { siblings: sibs, index: Math.max(0, sibs.indexOf(path)) };
  } catch {
    return { siblings: [path], index: 0 };
  }
}

/** 关闭并销毁一个视图实例（tab 关闭/插件停用/单例被接管/用户点关闭） */
export function closeView(id: string): void {
  const v = views.get(id);
  if (!v) return;
  if (curActiveViewId === id) {
    curActiveViewId = "";
    document.getElementById("plugin-view-host")?.classList.add("hidden");
    document.getElementById("reader-content")?.classList.remove("hidden");
    mediaDock.setActiveView("");
  }
  releaseAwake(`view:${id}`);
  try {
    v.inst.deactivate();
  } catch (e) {
    console.error("[plugin] deactivate 失败:", e);
  }
  v.pane.remove();
  views.delete(id);
  mediaDock.detach(id);
  document.dispatchEvent(new CustomEvent("rb-view-closed", { detail: id }));
  app.updateUI();
}

/** 换显某实例面板为可见（tab 切换/新视图打开）：旧激活面板隐藏但保活 */
export function activateView(id: string): void {
  const v = views.get(id);
  if (!v) return;
  if (curActiveViewId && curActiveViewId !== id) {
    const prev = views.get(curActiveViewId);
    prev?.pane.classList.add("hidden");
    prev?.inst.setActive?.(false);
  }
  curActiveViewId = id;
  v.pane.classList.remove("hidden");
  v.inst.setActive?.(true);
  document.getElementById("plugin-view-host")?.classList.remove("hidden");
  document.getElementById("reader-content")?.classList.add("hidden");
  mediaDock.setActiveView(id);
  app.updateUI();
}

/** 收起激活视图面板但不销毁（tab 切到文本 tab 时用） */
export function hideActiveView(): void {
  const v = views.get(curActiveViewId);
  if (!v) return;
  v.pane.classList.add("hidden");
  v.inst.setActive?.(false);
  curActiveViewId = "";
  document.getElementById("plugin-view-host")?.classList.add("hidden");
  document.getElementById("reader-content")?.classList.remove("hidden");
  mediaDock.setActiveView("");
  app.updateUI();
}

/** 旧单例接口插件 → 实例包装：插件对象自身持状态，包装层转发 */
function wrapSingleton(p: ReadBookPlugin): PluginViewInstance {
  return {
    open: (ctx) => p.open?.(ctx),
    deactivate: () => p.deactivate?.(),
    togglePlay: () => p.togglePlay?.(),
    navFile: (d) => p.navFile?.(d),
    isPlaying: () => p.isPlaying?.() ?? false,
  };
}

/** 让启用的插件接管打开一个文件（扩展名未命中返回 null）。
 *  多实例插件：新实例入表并激活（旧视图面板隐藏保活，归属各自 tab）；
 *  单例插件：同插件旧视图先销毁（视图随新打开移动）。 */
export async function openFile(path: string): Promise<string | null> {
  const { zipPath, entry, base } = splitTarget(path);
  const ext = extOf(base);
  const plugin = handlerForExt(ext);
  if (!plugin) return null;
  if (!plugin.createView) {
    for (const v of [...views.values()]) {
      if (v.plugin.id === plugin.id) closeView(v.id);
    }
  }
  let id = "";
  try {
    // wantsStream 的插件：本地与 SMB 普通文件跳过整文件预读（2GB+ 视频必需），改由流式协议按需分块
    const wantStream = !!plugin.wantsStream && isTauri() && !isSmbComposite(path);
    const bytes = wantStream
      ? new Uint8Array(0)
      : new Uint8Array(
          entry ? await api.readZipBytes(zipPath, entry) : await api.readFileBytes(path)
        );
    const { siblings, index } = await computeSiblings(path, ext);
    id = crypto.randomUUID();
    const pane = document.createElement("div");
    pane.className = "plugin-view-pane";
    const inst = plugin.createView ? plugin.createView() : wrapSingleton(plugin);
    const e0: ViewEntry = {
      id,
      plugin,
      inst,
      pane,
      status: {},
      file: baseName(base),
      openedName: baseName(zipPath || path),
      ctxPath: path,
      scopeZip: zipPath,
      scopeDir: zipPath ? "" : parentOf(base),
    };
    views.set(id, e0);
    const owner = e0;
    const ctx: PluginOpenContext = {
      // 存取器直写实例表：插件跨容器推进写 ctx.path 时宿主 activeFilePath() 随之更新
      //（与旧实现 activeCtx 同对象别名语义一致）
      get path() {
        return owner.ctxPath;
      },
      set path(p: string) {
        owner.ctxPath = p;
      },
      name: owner.file,
      ext,
      bytes,
      host: pane,
      viewId: id,
      closeView: () => closeView(id),
      siblings,
      siblingIndex: index,
      loadBytes: (p) => loadBytesIn(owner, p),
      listContainer: () => listContainerIn(owner),
      streamUrlFor: wantStream ? streamUrlFor : undefined,
      setStatus: (s) => {
        Object.assign(owner.status, s);
        if (curActiveViewId === id) app.updateUI(); // 后台实例只更新表内状态，不动 UI
      },
      getSetting: <T>(key: string, def: T) => pluginSetting<T>(plugin.id, key, def),
      setSetting: (key, value) => setPluginSetting(plugin.id, key, value),
      toast: (t) => app.toast(t),
      setKeepAwake: (on) => {
        if (views.has(id)) holdAwake(`view:${id}`, on); // 视图已销毁：忽略迟到的持有请求
      },
      togglePlayback: () => app.togglePlayback(),
    };
    document.getElementById("plugin-view-host")!.appendChild(pane);
    await inst.open(ctx);
    // 每个 tab 的视图随 tab 保活（Task 3 起由 tabs 层驱动 activateView/hideActiveView/closeView）
    activateView(id);
    return id;
  } catch (e) {
    if (id) {
      const v = views.get(id);
      if (v) {
        releaseAwake(`view:${id}`);
        try {
          v.inst.deactivate();
        } catch (de) {
          console.error("[plugin] deactivate 失败:", de);
        }
        v.pane.remove();
        views.delete(id);
        mediaDock.detach(id);
      }
      id = "";
    }
    app.showMessage("打开失败", String(e));
    return null;
  }
}

/* ========== 插件固定设置与菜单 ========== */

/** 读插件固定设置（持久化于 settings.pluginSettings） */
export function pluginSetting<T>(id: string, key: string, def: T): T {
  const all = app.state.store.settings.pluginSettings || {};
  const v = all[id]?.[key];
  return (v === undefined || v === null ? def : v) as T;
}

/** 写插件固定设置并持久化 */
export function setPluginSetting(id: string, key: string, value: string | number | boolean): void {
  const s = app.state.store.settings;
  const cur = s.pluginSettings?.[id] || {};
  s.pluginSettings = { ...s.pluginSettings, [id]: { ...cur, [key]: value } };
  app.persist();
}

/** 聚合启用插件的菜单：每个插件一个子菜单条目（设置在其内部层级展开） */
export function pluginMenuItems(): MenuItemDef[] {
  const out: MenuItemDef[] = [];
  for (const p of plugins) {
    if (!isEnabled(p) || !p.menu) continue;
    out.push({ label: p.name, children: () => p.menu!() });
  }
  return out;
}

/* ========== 插件管理面板 ========== */

let toggleFn: (id: string, on: boolean) => void = () => {};

export function initPluginSystem(toggle: (id: string, on: boolean) => void): void {
  toggleFn = toggle;
  document.addEventListener("rb-open-panel", (e) => {
    if ((e as CustomEvent).detail !== "plugin-panel") return;
    renderPluginPanel();
  });
  // 安装/卸载后外部插件集合变化：面板开着时即时刷新
  document.addEventListener("rb-plugins-changed", () => {
    if (!document.getElementById("plugin-panel")?.classList.contains("hidden")) renderPluginPanel();
  });
  document.addEventListener("rb-escape", () => {
    if (curActiveViewId) closeView(curActiveViewId);
  });
  // 媒体坞迷你条 ⏸/▶：按会话 id 分发到对应实例（后台实例也响应——视频隐藏面板中可继续控制）
  document.addEventListener("rb-dock-toggle", (e) => {
    const inst = views.get(String((e as CustomEvent).detail))?.inst;
    try {
      inst?.togglePlay?.();
    } catch (e) {
      console.error("[rb-dock-toggle] togglePlay 失败:", e);
    }
  });
}

function renderPluginPanel(): void {
  const box = document.getElementById("plugin-list");
  if (!box) return;
  box.innerHTML = "";
  if (plugins.length === 0 && loadErrors.length === 0) {
    box.innerHTML = '<div style="padding:16px;font-size:12px;color:#888">暂无已安装插件。</div>';
    return;
  }
  for (const p of plugins) {
    const pkg = externalPkgs.get(p.id);
    const row = document.createElement("div");
    row.className = "plugin-row";
    const info = document.createElement("div");
    info.className = "plugin-info";
    const nameLine = document.createElement("div");
    nameLine.className = "plugin-name";
    nameLine.textContent = p.name + " ";
    const ver = document.createElement("span");
    ver.className = "plugin-ver";
    ver.textContent = `v${p.version}`;
    nameLine.appendChild(ver);
    if (pkg) {
      const badge = document.createElement("span");
      badge.className = "plugin-badge";
      badge.textContent = "外部";
      badge.title = pkg.dir ? `安装于 ${pkg.dir}` : "外部插件包";
      nameLine.appendChild(badge);
    }
    const desc = document.createElement("div");
    desc.className = "plugin-desc";
    desc.textContent = p.description;
    const exts = document.createElement("div");
    exts.className = "plugin-exts";
    exts.textContent = `支持格式：${p.extensions.join(" ")}`;
    info.append(nameLine, desc, exts);
    row.append(info);

    const ops = document.createElement("div");
    ops.className = "plugin-ops";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "plugin-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isEnabled(p);
    cb.addEventListener("change", () => {
      toggleFn(p.id, cb.checked);
      if (!cb.checked) {
        for (const v of [...views.values()]) {
          if (v.plugin.id === p.id) closeView(v.id);
        }
      }
    });
    toggleLabel.append(cb, document.createTextNode("启用"));
    ops.appendChild(toggleLabel);
    if (pkg) {
      const del = document.createElement("button");
      del.className = "plugin-uninstall";
      del.textContent = "卸载";
      del.title = "卸载插件包（目录移入回收站，可恢复）";
      del.addEventListener("click", () => {
        del.disabled = true;
        document.dispatchEvent(new CustomEvent("rb-uninstall-plugin", { detail: p.id }));
      });
      ops.appendChild(del);
    }
    row.appendChild(ops);
    box.appendChild(row);
  }
  for (const err of loadErrors) {
    const row = document.createElement("div");
    row.className = "plugin-row plugin-error";
    const info = document.createElement("div");
    info.className = "plugin-info";
    const nameLine = document.createElement("div");
    nameLine.className = "plugin-name";
    nameLine.textContent = `${err.name} v${err.version}`;
    const badge = document.createElement("span");
    badge.className = "plugin-badge";
    badge.textContent = "外部";
    nameLine.appendChild(badge);
    const desc = document.createElement("div");
    desc.className = "plugin-desc";
    desc.textContent = `加载失败：${err.error}`;
    info.append(nameLine, desc);
    row.append(info);
    const ops = document.createElement("div");
    ops.className = "plugin-ops";
    const del = document.createElement("button");
    del.className = "plugin-uninstall";
    del.textContent = "卸载";
    del.addEventListener("click", () => {
      del.disabled = true;
      document.dispatchEvent(new CustomEvent("rb-uninstall-plugin", { detail: err.id }));
    });
    ops.appendChild(del);
    row.appendChild(ops);
    box.appendChild(row);
  }
}
