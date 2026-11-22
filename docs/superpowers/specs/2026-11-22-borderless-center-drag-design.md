# 设计：无边框模式按住阅读区中央拖动移动窗口

日期：2026-11-22

## 问题

无边框模式（F9）隐藏系统标题栏后窗口无法移动（README 现状：「期间不可拖动/调整大小」）。目标：无边框期间在阅读区（窗口中央）按住拖动即可移动窗口。

## 核心取舍（已与用户确认）

阅读区是 `user-select: text`（双击取词→局部编辑、拖选文字供查找默认词）。采用**移动超阈值才算拖窗**方案：

- 按下后位移 ≥5px 才调用系统拖窗；单击、双击取词完全不受影响
- 代价：无边框期间「按住拖选文字」变成拖窗（沉浸阅读可接受）；退出无边框一切恢复
- 备选否决项：按 Alt 拖（需键盘配合）、按下立即拖（双击取词失效）

## 实现

1. **`src/fullscreen.ts`**（无边框模块内新增，initFullscreen 挂载）：
   - `#reader-content` 上监听 mousedown：仅无边框（`isBorderless()`）、非浏览器演示、左键时记起点并武装
   - mousemove 位移 ≥ `DRAG_THRESHOLD`(5px)：先 `getSelection().removeAllRanges()` 清半截选区，再 `getCurrentWindow().startDragging()`（try/catch），解除武装
   - window mouseup 兜底解除武装；拖窗开始后 OS 接管指针，残留武装无副作用（下次 mousedown 先复位）
   - 插件视图/面板/四边热区均为上层元素，不落在 reader-content 上，天然不误拖
2. **`src-tauri/capabilities/default.json`**：加 `core:window:allow-start-dragging`（缺失会静默失效，同置顶权限坑 de3bce0）

## 不改的东西

- 不加 `user-select: none`（会连累双击取词失效）；cursor 保持 text
- 普通窗口模式（有标题栏）不引入；`index.html`/`shortcut.ts` 无结构/快捷键改动

## 同步项

- README 无边框模式行补「按住中央拖动可移动窗口」
- `menubar.ts` showShortcuts 的 F9 描述、进入无边框 toast（app.ts）提及中央拖动

## 验证

- `npm run build`（tsc 类型检查 + vite）+ `cargo check`（build.rs 会校验 capabilities 权限标识）
- 浏览器演示回归：无边框切换、双击取词不受影响；真实拖窗为 OS 级行为，需用户桌面端手测
