/* 全局快捷键（参照 ReadBook 原版习惯） */
import * as app from "./app";
import * as reader from "./reader";
import * as folder from "./folder";
import * as plugins from "./plugins/registry";
import * as tabs from "./tabs";
import { isFindOpen, closeFind, findNext, findPrev } from "./findbar";

export function initShortcuts(): void {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing =
      !!t &&
      (t.tagName === "INPUT" ||
        t.tagName === "SELECT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable);

    if (e.key === "Escape") {
      if (isFindOpen()) {
        closeFind();
        return;
      }
      app.handleEscape();
      return;
    }
    if (typing) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;

    // Ctrl 组合
    if (ctrl) {
      switch (key.toLowerCase()) {
        case "o":
          e.preventDefault();
          if (e.shiftKey) void folder.pickFolder();
          else if (e.altKey)
            void (async () => {
              await folder.openFolderPanel();
              await folder.switchSideTab("smb");
            })();
          else app.openFileDialog();
          return;
        case "w":
          e.preventDefault();
          app.closeFile();
          return;
        case "z":
          e.preventDefault();
          app.goBack();
          return;
        case "f":
          e.preventDefault();
          document.dispatchEvent(new CustomEvent("rb-open-find"));
          return;
        case "k":
          e.preventDefault();
          document.dispatchEvent(new CustomEvent("rb-open-panel", { detail: "keyword-panel" }));
          return;
        case "b":
          e.preventDefault();
          app.addBookmark();
          return;
        case "s":
          e.preventDefault();
          if (e.shiftKey) app.addToBookshelf();
          else app.saveAs();
          return;
        case "e":
          e.preventDefault();
          app.openEditor();
          return;
        case "d":
          e.preventDefault();
          app.toggleDual();
          return;
        case "q":
          e.preventDefault();
          app.exitApp();
          return;
        case ",":
          e.preventDefault();
          void import("./settings").then((m) => m.openSettings());
          return;
      }
      if (key === "Tab") {
        e.preventDefault();
        tabs.cycleActive(e.shiftKey ? -1 : 1);
        return;
      }
      if (key === "PageDown") {
        e.preventDefault();
        void app.gotoNextFile(); // 插件视图内分发为插件 navFile
        return;
      }
      if (key === "PageUp") {
        e.preventDefault();
        void app.gotoPrevFile();
        return;
      }
      return;
    }

    // 全屏切换不受插件视图屏蔽（公共沉浸功能，插件栏吸附照常可用）
    if (key === "F11") {
      e.preventDefault();
      app.toggleFullscreen();
      return;
    }

    // 滚屏/播放公共入口不受插件视图屏蔽：宿主按视图类型分发（文本滚屏 / 插件播放切换）
    if (key === " ") {
      e.preventDefault();
      app.togglePlayback();
      return;
    }

    // 隐藏到托盘不受插件视图屏蔽（应用级公共操作，插件无 T 键位占用）
    if (key === "t" || key === "T") {
      app.hideToTray();
      return;
    }

    // 速度键不受插件视图屏蔽：速度是全局设置（工具栏速度标签常驻展示），
    // 也实时驱动插件视图的宿主滚屏引擎（ctx.autoscroll）；内置/参考插件均未占用数字/± 键
    if (key >= "1" && key <= "9") {
      app.setSpeed(Number(key) * 45); // 1-9 预设档位 → 45..405 像素/秒
      app.toast(`速度: ${Number(key) * 45} 像素/秒`);
      return;
    }
    if (key === "+" || key === "=") {
      app.adjustSpeed(1);
      return;
    }
    if (key === "-") {
      app.adjustSpeed(-1);
      return;
    }

    // 插件视图激活期间，屏蔽作用于隐藏文本区的按键（P/PgUp/PgDn/Home/End
    // 与功能键），交给插件自己的快捷键处理；Esc（关闭插件视图）、Space、T、Ctrl 组合
    // 与速度键不受影响
    if (plugins.isActive()) return;

    // 功能键
    if (key === "F5") {
      e.preventDefault();
      app.doReorder();
      return;
    }
    if (key === "F1") {
      e.preventDefault();
      // 菜单栏用 mousedown 触发，这里派发同样的事件
      document
        .querySelector<HTMLElement>('.menu-item[data-menu="help"]')
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return;
    }
    if (key === "F3") {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else if (isFindOpen()) findNext();
      else document.dispatchEvent(new CustomEvent("rb-open-find"));
      return;
    }

    // 单键
    if (key === "p" || key === "P") {
      app.toggleScrollMode();
      return;
    }
    if (key === "PageDown") {
      e.preventDefault();
      reader.pageDown();
      return;
    }
    if (key === "PageUp") {
      e.preventDefault();
      reader.pageUp();
      return;
    }
    if (key === "Home") {
      e.preventDefault();
      app.jumpToRatio(0);
      return;
    }
    if (key === "End") {
      e.preventDefault();
      app.jumpToRatio(1);
      return;
    }
  });

  // 全屏状态同步到工具栏按钮
  document.addEventListener("fullscreenchange", () => app.updateUI());
}
