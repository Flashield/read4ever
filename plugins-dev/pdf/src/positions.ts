/* PDF 阅读进度存档的纯逻辑（可测缝）：Record<路径, 存档>，经 ctx.getSetting/setSetting
   以 JSON 字符串落 settings.pluginSettings.pdf.positions。LRU 上限 200 条：
   写入即触达（t 刷新为最新），超限淘汰 t 最旧的条目。 */
export interface PdfSavedPos {
  i: number; // 页索引（0 起）
  r: number; // 页内滚动比（0..1）
  t: number; // 最近触达时间戳（新鲜度）
}
export type PosMap = Record<string, PdfSavedPos>;
export const POS_LIMIT = 200;
export const POS_DEBOUNCE_MS = 2000;

/** 宽松解析存档 JSON：任何畸形输入兜底空表；字段不全的条目剔除 */
export function parsePosMap(raw: string | null | undefined): PosMap {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: PosMap = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      const p = e as Partial<PdfSavedPos> | null;
      if (!p || typeof p !== "object" || typeof p.i !== "number" || typeof p.r !== "number") continue;
      out[k] = { i: p.i, r: p.r, t: typeof p.t === "number" ? p.t : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写入一条进度（t=now，触达即刷新新鲜度），超 POS_LIMIT 淘汰 t 最旧者；返回新表（不改入参） */
export function upsertPos(
  map: PosMap,
  path: string,
  pos: { i: number; r: number },
  now: number = Date.now()
): PosMap {
  const next: PosMap = { ...map, [path]: { i: pos.i, r: pos.r, t: now } };
  const keys = Object.keys(next);
  if (keys.length > POS_LIMIT) {
    keys.sort((a, b) => next[a].t - next[b].t);
    for (const k of keys.slice(0, keys.length - POS_LIMIT)) delete next[k];
  }
  return next;
}
