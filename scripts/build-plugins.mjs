/* 构建全部外部插件：tsc 类型检查 → esbuild 打包单文件 ESM → fflate zipSync 打 .rbplugin。
   产物在 plugins-dev/<id>/dist/（gitignore），zip 条目仅 manifest.json + main.js。 */
import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devDir = join(root, "plugins-dev");

/* esbuild 只保留 /*!、//! 与含 @license 的注释，marked 的普通块注释文件头会被剥掉。
   产物命中库名时在头部补挂其版权横幅（版本号读自 node_modules），保证协议声明随包分发。 */
const LIB_BANNERS = {
  // marker 匹配 esbuild 产物里的模块路径注释（比裸库名特异，防代码里恰好出现同名变量/注释而误挂横幅）
  marked: {
    marker: "node_modules/marked/",
    banner: () => {
      const ver = JSON.parse(readFileSync(join(root, "node_modules", "marked", "package.json"), "utf8")).version;
      return `/*! 内含 marked v${ver}（MIT License）© MarkedJS、Christopher Jeffrey — https://github.com/markedjs/marked */`;
    },
  },
  "pdfjs-dist": {
    marker: "node_modules/pdfjs-dist/",
    banner: () => {
      const ver = JSON.parse(readFileSync(join(root, "node_modules", "pdfjs-dist", "package.json"), "utf8")).version;
      return `/*! 内含 pdf.js v${ver}（Apache License 2.0）© Mozilla Foundation — https://github.com/mozilla/pdf.js */`;
    },
  },
};

/* PDF 插件把 pdf.js worker 以文本内联进产物（运行时 blob 自启动，见 plugins-dev/pdf/src/main.ts）。
   esbuild 无 query-loader 机制：打包前把 worker 源码复制为 .txt，配合下方 loader: { ".txt": "text" }
   以字符串导入；副本落在 dist/（gitignore），不进版本控制。 */
function preparePdfWorkerText(out) {
  const src = join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
  if (!existsSync(src)) throw new Error("pdfjs-dist 未安装，无法内联 PDF worker");
  copyFileSync(src, join(out, "pdf.worker.min.mjs.txt"));
}

/* PDF 插件把 pdfjs-dist 的简繁中文系列 CMap（.bcmap 二进制压缩预定义字符映射）以 base64
   内联进产物：非嵌入 CID 中文字体（GBK/Big5/UniGB/UniCNS 等编码）依赖这些表把 CID 映射
   到 Unicode，缺失时整段文字渲染为空白或豆腐块。日/韩文系列不收（用不到，控包体积），
   Adobe-GB1/CNS1 基础序列全收（useCMap 扩展链逐级引用基础表，缺一环链条即断）。
   数据写入 dist/cmaps.gen.txt（gitignore，同 worker 文本先例），运行时
   main.ts 的 InlineBinaryDataFactory 按文件名解码。 */
const CMAP_ZH_FAMILIES = /^(Adobe-(GB1|CNS1)|B5|CNS|ETen|GB|HK|UniCNS|UniGB)/;

function preparePdfCmaps(out) {
  const dir = join(root, "node_modules", "pdfjs-dist", "cmaps");
  if (!existsSync(dir)) throw new Error("pdfjs-dist 未安装，无法内联中文 CMaps");
  const packed = {};
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".bcmap") && CMAP_ZH_FAMILIES.test(f)))
    packed[n.slice(0, -".bcmap".length)] = readFileSync(join(dir, n)).toString("base64");
  writeFileSync(join(out, "cmaps.gen.txt"), JSON.stringify(packed));
  return Object.keys(packed).length;
}

execSync("npx tsc --noEmit -p plugins-dev/tsconfig.json", { cwd: root, stdio: "inherit" });

for (const name of readdirSync(devDir)) {
  const dir = join(devDir, name);
  if (!statSync(dir).isDirectory() || name.startsWith("_") || name.startsWith(".")) continue;
  if (!readdirSync(dir).includes("manifest.json")) continue; // 非插件目录（tsconfig 等）
  const out = join(dir, "dist");
  mkdirSync(out, { recursive: true });
  if (name === "pdf") {
    preparePdfWorkerText(out);
    const cmapCount = preparePdfCmaps(out);
    console.log(`[plugins] pdf：内联中文 CMaps ${cmapCount} 个`);
  }
  await build({
    entryPoints: [join(dir, "src/main.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(out, "main.js"),
    minify: false, // 产物保持可读，便于用户审查外部插件代码
    legalComments: "inline", // markdown-viewer 打包了 MIT 协议的 marked，版权声明保留在产物注释
    loader: { ".txt": "text" }, // PDF 插件的 worker 文本副本以字符串导入内联
    logLevel: "warning",
  });
  const mainJs = join(out, "main.js");
  let code = readFileSync(mainJs, "utf8");
  for (const { marker, banner } of Object.values(LIB_BANNERS)) {
    if (code.includes(marker)) code = `${banner()}\n${code}`;
  }
  writeFileSync(mainJs, code);
  /* 浏览器演示通道（mock_backend 经 vite dev fetch 产物）：vite 会转换 .js 静态请求
     （import 分析对 pdf.js 的动态 import 注入 /@vite/client，blob 模块里无法解析），
     故另存一份非 JS 扩展名的同内容副本供演示 fetch 原文；桌面端 .rbplugin 仍装 main.js。 */
  writeFileSync(join(out, "main.js.txt"), code);
  const pkg = zipSync(
    {
      "manifest.json": new Uint8Array(readFileSync(join(dir, "manifest.json"))),
      "main.js": strToU8(readFileSync(mainJs, "utf8")),
    },
    { level: 6 }
  );
  writeFileSync(join(out, `${name}.rbplugin`), pkg);
  console.log(`[plugins] ${name} → dist/main.js + dist/${name}.rbplugin`);
}
