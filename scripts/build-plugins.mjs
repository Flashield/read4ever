/* 构建全部外部插件：tsc 类型检查 → esbuild 打包单文件 ESM → fflate zipSync 打 .rbplugin。
   产物在 plugins-dev/<id>/dist/（gitignore），zip 条目仅 manifest.json + main.js。 */
import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
};

execSync("npx tsc --noEmit -p plugins-dev/tsconfig.json", { cwd: root, stdio: "inherit" });

for (const name of readdirSync(devDir)) {
  const dir = join(devDir, name);
  if (!statSync(dir).isDirectory() || name.startsWith("_") || name.startsWith(".")) continue;
  if (!readdirSync(dir).includes("manifest.json")) continue; // 非插件目录（tsconfig 等）
  const out = join(dir, "dist");
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(dir, "src/main.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(out, "main.js"),
    minify: false, // 产物保持可读，便于用户审查外部插件代码
    legalComments: "inline", // markdown-viewer 打包了 MIT 协议的 marked，版权声明保留在产物注释
    logLevel: "warning",
  });
  const mainJs = join(out, "main.js");
  let code = readFileSync(mainJs, "utf8");
  for (const { marker, banner } of Object.values(LIB_BANNERS)) {
    if (code.includes(marker)) code = `${banner()}\n${code}`;
  }
  writeFileSync(mainJs, code);
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
