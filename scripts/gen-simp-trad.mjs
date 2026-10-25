/* 生成 src/simp_trad_data.ts：用 zhconv 对 CJK 基本区逐字转换，导出字符对照对。
   仅开发期使用：npm run gen:simptrad。运行时代码只依赖生成出的数据文件。 */
import { writeFileSync } from "node:fs";
import { zhconv } from "zhconv";

// 字符级转换的安全黑名单：这些简体字在繁体里一词多形（如 了→瞭/了、面→麵/面），
// 逐字强转会破坏正常句子，保持原字由读者自行判断。
const S2T_BLACKLIST = new Set([
  "了", "出", "面", "表", "布", "里", "后", "谷", "冲", "卷", "板", "干",
  "斗", "几", "才", "胡", "法", "秋", "芸", "只", "松", "征",
]);

// 繁→简方向基本安全，无需黑名单
let s2tPairs = [];
let t2sPairs = [];

// CJK 扩展A + 基本区
let all = "";
for (let cp = 0x3400; cp <= 0x9fff; cp++) all += String.fromCodePoint(cp);

const trad = zhconv(all, "zh-hant");
const simp = zhconv(all, "zh-hans");

const chars = Array.from(all);
const tArr = Array.from(trad);
const sArr = Array.from(simp);

for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  if (tArr[i] && tArr[i] !== c && !S2T_BLACKLIST.has(c)) s2tPairs.push(c + tArr[i]);
  if (sArr[i] && sArr[i] !== c) t2sPairs.push(c + sArr[i]);
}

const out = `/* 本文件由 scripts/gen-simp-trad.mjs 生成（npm run gen:simptrad），请勿手改。 */
/* 每对为 原+目标 相邻排列；运行时解析为映射表。 */

export const S2T_PAIRS = ${JSON.stringify(s2tPairs.join(""))};

export const T2S_PAIRS = ${JSON.stringify(t2sPairs.join(""))};
`;

writeFileSync(new URL("../src/simp_trad_data.ts", import.meta.url), out, "utf-8");
console.log(`s2t: ${s2tPairs.length} 对, t2s: ${t2sPairs.length} 对`);
