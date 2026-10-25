/* 插件注册表与中央打开管线：按扩展名路由到启用的插件 */
import { api } from "../api";
import * as app from "../app";
import type { MenuItemDef } from "../dropdown";
import type { FileEntry } from "../types";
import type { PluginOpenContext, ReadBookPlugin } from "./types";

const TEXT_RE = /\.(txt|zip)$/i;

const plugins: ReadBookPlugin[] = [];
/** 插件 id → 是否启用；未列出的默认启用 */
let enabledMap: Record<string, boolean> = {};
let active: ReadBookPlugin | null = null;

export function register(p: ReadBookPlugin): void {
  if (!plugins.some((x) => x.id === p.id)) plugins.push(p);
}

export function list(): ReadBookPlugin[] {
  return [...plugins];
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

function splitTarget(path: string): { zipPath: string; entry: string; base: string } {
  const m = path.match(/^(.+\.zip)::(.+)$/i);
  if (m) return { zipPath: m[1], entry: m[2], base: m[2] };
  return { zipPath: "", entry: "", base: path };
}

async function loadBytes(path: string): Promise<Uint8Array> {
  const { zipPath, entry } = splitTarget(path);
  const buf = entry
    ? await api.readZipBytes(zipPath, entry)
    : await api.readFileBytes(path);
  return new Uint8Array(buf);
}

async function computeSiblings(path: string, ext: string): Promise<{ siblings: string[]; index: number }> {
  const { zipPath, entry, base } = splitTarget(path);
  try {
    if (entry) {
      const all = await api.listZip(zipPath);
      const sibs = all.filter((n) => extOf(n) === ext).map((n) => `${zipPath}::${n}`);
      return { siblings: sibs, index: Math.max(0, sibs.indexOf(path)) };
    }
    const sep = base.includes("\\") ? "\\" : "/";
    const dir = base.slice(0, Math.max(base.lastIndexOf(sep), 0));
    const entries: FileEntry[] = await api.listDir(dir);
    const sibs = entries.filter((e) => !e.isDir && extOf(e.name) === ext).map((e) => e.path);
    return { siblings: sibs, index: Math.max(0, sibs.indexOf(path)) };
  } catch {
    return { siblings: [path], index: 0 };
  }
}

/** 关闭当前插件视图并恢复文本渲染（无插件视图时为空操作） */
export function deactivateActive(): void {
  if (!active) return;
  const p = active;
  active = null;
  try {
    p.deactivate?.();
  } catch (e) {
    console.error("[plugin] deactivate 失败:", e);
  }
  const h = document.getElementById("plugin-view-host");
  if (h) {
    h.innerHTML = "";
    h.classList.add("hidden");
  }
  document.getElementById("reader-content")?.classList.remove("hidden");
  app.updateUI();
}

/** 让启用的插件接管打开一个文件（扩展名未命中时为空操作）。
 *  旧插件视图保持显示直到新视图就绪——切换图片等场景不会闪现文本。 */
export async function openFile(path: string): Promise<void> {
  const { zipPath, entry, base } = splitTarget(path);
  const ext = extOf(base);
  const plugin = handlerForExt(ext);
  if (!plugin) return;
  const prev = active;
  try {
    const buf = entry
      ? await api.readZipBytes(zipPath, entry)
      : await api.readFileBytes(path);
    const { siblings, index } = await computeSiblings(path, ext);
    const host = document.getElementById("plugin-view-host")!;
    // 就绪后才切换：清旧 DOM、建新视图（旧插件资源随后清理）
    host.innerHTML = "";
    host.classList.remove("hidden");
    document.getElementById("reader-content")?.classList.add("hidden");
    active = plugin;
    const ctx: PluginOpenContext = {
      path,
      name: base.split(/[\\/]/).filter(Boolean).pop() || base,
      ext,
      bytes: new Uint8Array(buf),
      host,
      siblings,
      siblingIndex: index,
      loadBytes: (p) => loadBytes(p),
    };
    await plugin.open(ctx);
    if (prev && prev !== plugin) {
      try {
        prev.deactivate?.();
      } catch (e) {
        console.error("[plugin] deactivate 失败:", e);
      }
    }
  } catch (e) {
    deactivateActive();
    app.showMessage("打开失败", String(e));
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

export function initPluginSystem(toggle: (id: string, on: boolean) => void): void {
  document.addEventListener("rb-open-panel", (e) => {
    if ((e as CustomEvent).detail !== "plugin-panel") return;
    renderPluginPanel(toggle);
  });
  document.addEventListener("rb-escape", () => {
    if (active) deactivateActive();
  });
}

function renderPluginPanel(toggle: (id: string, on: boolean) => void): void {
  const box = document.getElementById("plugin-list");
  if (!box) return;
  box.innerHTML = "";
  if (plugins.length === 0) {
    box.innerHTML = '<div style="padding:16px;font-size:12px;color:#888">暂无已安装插件。</div>';
    return;
  }
  for (const p of plugins) {
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
    const desc = document.createElement("div");
    desc.className = "plugin-desc";
    desc.textContent = p.description;
    const exts = document.createElement("div");
    exts.className = "plugin-exts";
    exts.textContent = `支持格式：${p.extensions.join(" ")}`;
    info.append(nameLine, desc, exts);
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "plugin-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isEnabled(p);
    cb.addEventListener("change", () => {
      toggle(p.id, cb.checked);
      if (!cb.checked && active?.id === p.id) deactivateActive();
    });
    toggleLabel.append(cb, document.createTextNode("启用"));
    row.append(info, toggleLabel);
    box.appendChild(row);
  }
}
