/* 外部插件加载器：Rust 侧负责安装/列举（plugins/ 目录），
   本模块读取包内入口 main.js，以 blob URL 动态 import 实例化，
   校验导出形状后注册进 registry——与内置插件共用同一管线。
   外部插件代码只拿到 PluginOpenContext 里的受控能力，不 import 宿主模块。 */
import { api } from "../api";
import * as app from "../app";
import * as registry from "./registry";
import type { Read4EverPlugin } from "./types";

/** 已创建的 blob 模块 URL（重载时统一 revoke） */
const moduleUrls: string[] = [];
let loading = false;

/** 入口导出形状校验：必须是 default（或 plugin）导出的 Read4EverPlugin */
function validatePlugin(p: unknown, pkgId: string): p is Read4EverPlugin {
  if (!p || typeof p !== "object") {
    throw new Error("入口未导出插件对象（需 default 导出 Read4EverPlugin）");
  }
  const o = p as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) throw new Error("缺少 id");
  if (id !== pkgId) throw new Error(`manifest id "${pkgId}" 与入口导出 id "${id}" 不一致`);
  if (!o.name || typeof o.name !== "string") throw new Error("缺少 name");
  if (!o.version || typeof o.version !== "string") throw new Error("缺少 version");
  if (!Array.isArray(o.extensions) || o.extensions.length === 0) throw new Error("缺少 extensions");
  if (typeof o.open !== "function") throw new Error("缺少 open(ctx) 方法");
  return true;
}

/** 扫描并加载全部已安装外部插件；单个失败记入面板错误列表，不影响其余插件 */
export async function loadExternalPlugins(): Promise<void> {
  if (loading) return;
  loading = true;
  const errors: registry.PluginLoadError[] = [];
  try {
    const pkgs = await api.listPlugins();
    for (const pkg of pkgs) {
      try {
        const buf = await api.readPluginFile(pkg.id, pkg.entry);
        const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "text/javascript" }));
        moduleUrls.push(url);
        const mod = (await import(/* @vite-ignore */ url)) as {
          default?: unknown;
          plugin?: unknown;
        };
        const p = mod.default ?? mod.plugin;
        if (validatePlugin(p, pkg.id) && !registry.register(p, pkg)) {
          throw new Error(`插件 id "${pkg.id}" 与内置插件冲突，已跳过`);
        }
      } catch (e) {
        errors.push({
          id: pkg.id,
          name: pkg.name || pkg.id,
          version: pkg.version,
          error: String(e),
        });
      }
    }
  } catch {
    /* 后端不可用或无插件目录：保持无外部插件状态 */
  }
  registry.setLoadErrors(errors);
  loading = false;
  document.dispatchEvent(new CustomEvent("rb-plugins-changed"));
}

/** 重新扫描外部插件（安装/卸载后调用）：移除旧注册与模块 URL 后全量重载 */
export async function reloadExternalPlugins(): Promise<void> {
  for (const u of moduleUrls) URL.revokeObjectURL(u);
  moduleUrls.length = 0;
  for (const p of registry.list()) {
    if (registry.isExternal(p.id)) registry.unregister(p.id);
  }
  await loadExternalPlugins();
  // 可打开集合已变化：文件夹栏立即刷新
  void import("../folder").then((f) => f.refreshPanel());
}

/** 安装向导：选择 .rbplugin → 后端解包 → 重载 */
export async function installPluginDialog(): Promise<void> {
  const p = await api.pickPluginFile();
  if (!p) return;
  try {
    const info = await api.installPlugin(p);
    app.toast(`已安装 ${info.name} v${info.version}`);
    await reloadExternalPlugins();
  } catch (e) {
    app.showMessage("安装失败", String(e));
  }
}

export async function uninstallPlugin(id: string): Promise<void> {
  try {
    await api.uninstallPlugin(id);
    app.toast("已卸载插件（目录移入回收站）");
  } catch (e) {
    app.showMessage("卸载失败", String(e));
    return;
  }
  await reloadExternalPlugins();
}

export function initPluginLoader(): void {
  document
    .getElementById("plugin-install-btn")
    ?.addEventListener("click", () => void installPluginDialog());
  document.addEventListener("rb-uninstall-plugin", (e) => {
    void uninstallPlugin(String((e as CustomEvent).detail));
  });
}
