/* 设置中心（工具菜单「设置…」/ Ctrl+,）：行为类设置集中管理，即改即存。
   设计见 docs/多标签页、媒体坞与设置中心方案.md §3。
   副作用：keepAwake→常亮聚合器；naturalSort/含子目录→侧栏刷新；页模式间隔→reader。 */
import * as app from "./app";
import * as reader from "./reader";
import { setKeepAwakeEnabled } from "./keepawake";

function isSettingsOpen(): boolean {
  const m = document.getElementById("settings-modal");
  return !!m && !m.classList.contains("hidden");
}

export function openSettings(): void {
  if (isSettingsOpen()) return;
  syncFromStore();
  document.getElementById("settings-modal")?.classList.remove("hidden");
}

export function closeSettings(): void {
  document.getElementById("settings-modal")?.classList.add("hidden");
}

function syncFromStore(): void {
  const s = app.state.store.settings;
  const set = (id: string, v: string | number | boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v);
  };
  set("set-open-in-new-tab", s.openInNewTab);
  set("set-tab-switch-continue", s.tabSwitchPlayback === "continue");
  set("set-tab-limit", s.tabLimit);
  set("set-allow-multi-instance", s.allowMultipleInstances);
  set("set-auto-restore", s.autoRestore);
  set("set-folder-auto-open", s.folderAutoOpen);
  set("set-natural-sort", s.naturalSort);
  set("set-folder-recursive", s.folderListRecursive);
  set("set-keep-awake", s.keepAwake);
  set("set-play-borderless", s.playBorderless);
  set("set-page-interval", s.pageInterval);
}

function bindCheck(id: string, apply: (v: boolean) => void): void {
  document.getElementById(id)?.addEventListener("change", (e) => {
    apply((e.target as HTMLInputElement).checked);
    app.persist();
  });
}

export function initSettingsModal(): void {
  const s = () => app.state.store.settings;
  bindCheck("set-open-in-new-tab", (v) => (s().openInNewTab = v));
  bindCheck("set-tab-switch-continue", (v) => (s().tabSwitchPlayback = v ? "continue" : "pause"));
  bindCheck("set-allow-multi-instance", (v) => (s().allowMultipleInstances = v));
  document.getElementById("set-tab-limit")?.addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(50, Math.round(Number((e.target as HTMLInputElement).value)) || 20));
    s().tabLimit = v;
    (e.target as HTMLInputElement).value = String(v);
    app.persist();
  });
  bindCheck("set-auto-restore", (v) => (s().autoRestore = v));
  bindCheck("set-folder-auto-open", (v) => (s().folderAutoOpen = v));
  bindCheck("set-natural-sort", (v) => {
    s().naturalSort = v;
    void import("./folder").then((f) => f.refreshPanel());
    void import("./smb").then((m) => m.refreshAll());
  });
  bindCheck("set-folder-recursive", (v) => {
    s().folderListRecursive = v;
    void import("./folder").then((f) => f.refreshPanel());
  });
  bindCheck("set-keep-awake", (v) => {
    s().keepAwake = v;
    setKeepAwakeEnabled(v);
  });
  bindCheck("set-play-borderless", (v) => (s().playBorderless = v));
  document.getElementById("set-page-interval")?.addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(3600, Math.round(Number((e.target as HTMLInputElement).value)) || 10));
    s().pageInterval = v;
    (e.target as HTMLInputElement).value = String(v);
    reader.setPageInterval(v);
    app.persist();
  });
  document.getElementById("settings-close")?.addEventListener("click", closeSettings);
  document.getElementById("settings-done")?.addEventListener("click", closeSettings);
  document.getElementById("settings-modal")?.addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
}
