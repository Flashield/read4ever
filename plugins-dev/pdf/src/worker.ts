/* pdf.js worker 装配：blob 自启动（不依赖宿主 vite 配置），模块级复用。
   自 main.ts 迁出：main.ts 与 transport.ts（流式打开）共用，重复调用无害。 */
import "./shims"; // 宿主侧垫片：先于 pdfjs-dist 模块体求值
import * as pdfjsLib from "pdfjs-dist";
/* 垫片与 worker 正文均为构建期文本（scripts/build-plugins.mjs 先行落盘 dist/，经
   ".txt"=text loader 以字符串导入）：shims.gen.txt 由 src/shims.ts 单源编译（IIFE、
   无 import/export），worker blob = 垫片 + pdf.js worker——垫片在 worker 上下文先行
   求值，与宿主侧共用同一份实现，不再手写副本。 */
import shimsText from "../dist/shims.gen.txt?raw";
import workerText from "../dist/pdf.worker.min.mjs.txt?raw";

let workerUrl = ""; // worker 从 blob 实例化后 URL 即无存在必要，保留给后续打开复用

/** worker 以 blob 自启动（同源 blob URL 直接可用，无需宿主任何资源路径）；幂等 */
export function ensureWorker(): void {
  if (!workerUrl)
    workerUrl = URL.createObjectURL(new Blob([shimsText + "\n" + workerText], { type: "text/javascript" }));
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}
