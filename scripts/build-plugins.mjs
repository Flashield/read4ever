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
    legalComments: "none",
    logLevel: "warning",
  });
  const pkg = zipSync(
    {
      "manifest.json": new Uint8Array(readFileSync(join(dir, "manifest.json"))),
      "main.js": strToU8(readFileSync(join(out, "main.js"), "utf8")),
    },
    { level: 6 }
  );
  writeFileSync(join(out, `${name}.rbplugin`), pkg);
  console.log(`[plugins] ${name} → dist/main.js + dist/${name}.rbplugin`);
}
