/* 简繁体转换 — 字符级近似转换 */
/* 映射数据由 scripts/gen-simp-trad.mjs 基于 zhconv 生成（npm run gen:simptrad） */
import { S2T_PAIRS, T2S_PAIRS } from "./simp_trad_data";

function pairsToMap(pairs: string): Record<string, string> {
  const map: Record<string, string> = {};
  const chars = Array.from(pairs);
  for (let i = 0; i < chars.length; i += 2) {
    const s = chars[i];
    const t = chars[i + 1];
    if (s !== undefined && t !== undefined && !(s in map)) map[s] = t;
  }
  return map;
}

const S2T = pairsToMap(S2T_PAIRS);
const T2S = pairsToMap(T2S_PAIRS);

export type DisplayMode = "auto" | "simplified" | "traditional";

function toTraditional(text: string): string {
  let result = "";
  for (const ch of text) {
    result += S2T[ch] || ch;
  }
  return result;
}

function toSimplified(text: string): string {
  let result = "";
  for (const ch of text) {
    result += T2S[ch] || ch;
  }
  return result;
}

/** 根据显示模式转换文本 */
export function convertDisplay(text: string, mode: DisplayMode): string {
  if (mode === "traditional") return toTraditional(text);
  if (mode === "simplified") return toSimplified(text);
  return text;
}
