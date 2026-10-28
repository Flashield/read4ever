/* 菜单栏下拉定义与工具栏绑定 */
import * as app from "./app";
import * as reader from "./reader";
import * as folder from "./folder";
import * as registry from "./plugins/registry";
import { showDropdown, hideDropdown, isOpen, type MenuItemDef } from "./dropdown";
import { perfLine } from "./debug-perf"; // 【临时调试】
import { setKeepAwakeEnabled } from "./keepawake";

const MENUS: Record<string, () => MenuItemDef[]> = {
  file: () => [
    { label: "打开文件…", shortcut: "Ctrl+O", action: () => app.openFileDialog() },
    { label: "打开文件夹…", shortcut: "Ctrl+Shift+O", action: () => void folder.pickFolder() },
    {
      label: "浏览 SMB 远程共享…",
      shortcut: "Ctrl+Alt+O",
      action: () =>
        void (async () => {
          await folder.openFolderPanel();
          await folder.switchSideTab("smb");
        })(),
    },
    { sep: true },
    { label: "上一个文件", shortcut: "Ctrl+PgUp", action: () => app.gotoPrevFile(), disabled: !app.state.filePath },
    { label: "下一个文件", shortcut: "Ctrl+PgDn", action: () => app.gotoNextFile(), disabled: !app.state.filePath },
    { sep: true },
    { label: "另存为…", shortcut: "Ctrl+S", action: () => app.saveAs(), disabled: !app.state.filePath },
    { label: "关闭文件", shortcut: "Ctrl+W", action: () => app.closeFile(), disabled: !app.state.filePath && !registry.isActive() },
    { sep: true },
    { label: "隐藏到托盘", shortcut: "T", action: () => app.hideToTray() },
    { label: "退出", shortcut: "Ctrl+Q", action: () => app.exitApp() },
  ],
  view: () => [
    { label: "外观方案…", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "theme-panel" })) },
    { sep: true },
    { label: "简体显示", checked: () => app.state.displayMode === "simplified", action: () => app.setDisplayMode("simplified") },
    { label: "繁体显示", checked: () => app.state.displayMode === "traditional", action: () => app.setDisplayMode("traditional") },
    { label: "原码显示", checked: () => app.state.displayMode === "auto", action: () => app.setDisplayMode("auto") },
    { sep: true },
    { label: "双页模式", shortcut: "Ctrl+D", checked: () => reader.isDual(), action: () => app.toggleDual() },
    { label: "全屏阅读", shortcut: "F11", checked: () => app.isFullscreen(), action: () => app.toggleFullscreen() },
    { sep: true },
    {
      label: "启动时恢复上次阅读",
      checked: () => app.state.store.settings.autoRestore,
      action: () => {
        app.state.store.settings.autoRestore = !app.state.store.settings.autoRestore;
        app.persist();
      },
    },
    {
      label: "滚屏/播放时保持屏幕常亮",
      checked: () => app.state.store.settings.keepAwake,
      action: () => {
        app.state.store.settings.keepAwake = !app.state.store.settings.keepAwake;
        app.persist();
        setKeepAwakeEnabled(app.state.store.settings.keepAwake);
      },
    },
    {
      label: "启动时打开文件夹侧栏",
      checked: () => app.state.store.settings.folderAutoOpen,
      action: () => {
        app.state.store.settings.folderAutoOpen = !app.state.store.settings.folderAutoOpen;
        app.persist();
      },
    },
  ],
  read: () => [
    { label: reader.isScrolling() ? "停止滚屏" : "开始滚屏", shortcut: "Space", action: () => app.toggleScroll(), disabled: !app.state.filePath },
    { label: "页模式翻页", shortcut: "P", checked: () => reader.getMode() === "page", action: () => app.toggleScrollMode() },
    { sep: true },
    { label: "加速", shortcut: "+", action: () => app.adjustSpeed(1) },
    { label: "减速", shortcut: "-", action: () => app.adjustSpeed(-1) },
    { label: "滚屏速度…", action: () => app.showSpeedPicker() },
    { sep: true },
    { label: "翻到下页", shortcut: "PgDn", action: () => reader.pageDown() },
    { label: "翻到上页", shortcut: "PgUp", action: () => reader.pageUp() },
    { label: "回到上次位置", shortcut: "Ctrl+Z", action: () => app.goBack() },
    {
      label: "回到顶部",
      shortcut: "Home",
      action: () => {
        app.jumpToRatio(0);
      },
    },
    {
      label: "跳到文末",
      shortcut: "End",
      action: () => {
        app.jumpToRatio(1);
      },
    },
    { sep: true },
    { label: "添加书签", shortcut: "Ctrl+B", action: () => app.addBookmark(), disabled: !app.state.filePath },
    { label: "书签列表…", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "bookmark-panel" })) },
  ],
  tool: () => [
    { label: "查找…", shortcut: "Ctrl+F", action: () => document.dispatchEvent(new CustomEvent("rb-open-find")), disabled: !app.state.filePath },
    { label: "关键词检索与统计…", shortcut: "Ctrl+K", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "keyword-panel" })) },
    { label: "重新排版", shortcut: "F5", action: () => app.doReorder(), disabled: !app.state.filePath },
    { label: "局部编辑…", shortcut: "Ctrl+E", action: () => app.openEditor(), disabled: !app.state.filePath || app.state.isZip },
    { label: "以指定编码重新打开…", action: () => app.pickEncoding(), disabled: !app.state.filePath },
    { sep: true },
    { label: "插件管理…", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "plugin-panel" })) },
    { sep: true },
    { label: "加入收藏书架", shortcut: "Ctrl+Shift+S", action: () => app.addToBookshelf(), disabled: !app.state.filePath && !registry.isActive() },
    { label: "收藏书架…", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "bookshelf-panel" })) },
    { label: "历史记录…", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "history-panel" })) },
    { sep: true },
    { label: "清除历史记录", action: () => app.clearHistory() },
  ],
  plugin: () => [
    { label: "打开插件管理…", action: () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "plugin-panel" })) },
    { sep: true },
    ...registry.pluginMenuItems(),
  ],
  help: () => [
    { label: "快捷键列表…", shortcut: "F1", action: showShortcuts },
    { label: "关于 ReadBook…", action: showAbout },
  ],
};

function showShortcuts(): void {
  app.showMessage(
    "快捷键列表",
    [
      "Ctrl+O        打开文件",
      "Ctrl+Shift+O  打开文件夹（左侧栏树状浏览）",
      "Ctrl+Alt+O    浏览 SMB 远程共享（左侧栏远程标签）",
      "Ctrl+PgUp/Dn  上一个/下一个文件（按序号）",
      "Space         开始/停止滚屏",
      "1-9 / + / -   滚屏速度（点工具栏速度标签可输入任意像素值）",
      "P             切换连续滚屏 / 页模式翻页",
      "PgUp / PgDn   翻上一页 / 下一页",
      "Ctrl+Z        回到上次位置",
      "Home / End    回到顶部 / 跳到文末",
      "Ctrl+F        查找（? 通配任意一个字母或汉字）",
      "Ctrl+K        关键词检索与统计（组管理/统计/索引跳转）",
      "F3 / Shift+F3 查找下一个 / 上一个",
      "Ctrl+B        添加书签（书签列表：工具栏📑或阅读菜单）",
      "Ctrl+Shift+S  加入收藏书架",
      "Ctrl+S        另存为（可选编码）",
      "Ctrl+E        局部编辑选中的文字",
      "F5            重新排版（去硬回车）",
      "Ctrl+D        双页模式",
      "F11           全屏阅读（碰屏幕边缘呼出各栏）",
      "T             隐藏到系统托盘",
      "Ctrl+Q        退出",
      "Esc           关闭查找/面板/弹窗，退出全屏",
    ].join("\n")
  );
}

function showAbout(): void {
  app.showMessage(
    "关于 ReadBook",
    "ReadBook - 文本阅读器\n\n" +
      "复刻自经典阅读软件 ReadBook 的便携功能：\n" +
      "· 打开 TXT 与 ZIP 内的 TXT，自动识别编码\n" +
      "· 十余种阅读配色方案，字体字号行距可调\n" +
      "· 连续滚屏 / 页模式自动翻页\n" +
      "· 书签、收藏书架、历史记录与启动自动恢复\n" +
      "· 查找（? 通配符）、重新排版、简繁显示切换\n" +
      "· 双页模式、全屏阅读、最小化到系统托盘\n\n" +
      "基于 Tauri 2 构建。"
  );
}

/* ========== 菜单栏交互 ========== */

let activeMenuKey: string | null = null;

function menuX(key: string): number {
  const el = document.querySelector(`.menu-item[data-menu="${key}"]`) as HTMLElement | null;
  return el ? el.getBoundingClientRect().left : 8;
}

function openMenu(key: string): void {
  const tt = performance.now(); // 【临时调试】
  activeMenuKey = key;
  document.querySelectorAll(".menu-item").forEach((m) => m.classList.remove("active"));
  document.querySelector(`.menu-item[data-menu="${key}"]`)?.classList.add("active");
  showDropdown(MENUS[key](), menuX(key), 30);
  perfLine(`openMenu(${key}) 耗时 ${(performance.now() - tt).toFixed(0)}ms`); // 【临时调试】
}

export function initMenubar(): void {
  const items = document.querySelectorAll<HTMLElement>("#menu-bar .menu-item");
  items.forEach((el) => {
    const key = el.dataset.menu || "";
    el.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (isOpen() && activeMenuKey === key) {
        hideDropdown();
        activeMenuKey = null;
      } else {
        openMenu(key);
      }
    });
    // 已有菜单打开时，悬停切换
    el.addEventListener("mouseenter", () => {
      if (isOpen() && activeMenuKey !== key) openMenu(key);
    });
  });

  /* ========== 工具栏 ========== */
  const bind = (id: string, fn: () => void) => {
    document.getElementById(id)?.addEventListener("click", fn);
  };
  bind("btn-open", () => app.openFileDialog());
  bind("btn-folder", () => void folder.pickFolder());
  bind("btn-smb", () =>
    void (async () => {
      await folder.openFolderPanel();
      await folder.switchSideTab("smb");
    })()
  );
  bind("btn-prev-file", () => app.gotoPrevFile());
  bind("btn-next-file", () => app.gotoNextFile());
  bind("btn-scroll", () => app.toggleScroll());
  bind("btn-page-mode", () => app.toggleScrollMode());
  bind("btn-find", () => document.dispatchEvent(new CustomEvent("rb-open-find")));
  bind("btn-keyword", () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "keyword-panel" })));
  bind("btn-bookmark", () => app.addBookmark());
  bind("btn-bookmark-list", () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "bookmark-panel" })));
  bind("btn-bookshelf", () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "bookshelf-panel" })));
  bind("btn-history", () => document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "history-panel" })));
  bind("btn-reorder", () => app.doReorder());
  bind("btn-simp-trad", () => app.cycleDisplayMode());
  bind("btn-dual-page", () => app.toggleDual());
  bind("btn-fullscreen", () => app.toggleFullscreen());
  bind("btn-hide", () => app.hideToTray());

  // 状态/工具栏速度标签：点击弹出具体数值的速度选择
  document.getElementById("speed-label")?.addEventListener("click", () => app.showSpeedPicker());
}
