/* ReadBook 入口 */
import { boot } from "./app";
import { initDebugPerf } from "./debug-perf"; // 【临时调试】

/* 浏览器直接预览（无 Tauri 环境）时启用内置演示后端 */
if (!("__TAURI_INTERNALS__" in window)) {
  await import("./mock_backend");
}

initDebugPerf(); // 【临时调试】
boot();
