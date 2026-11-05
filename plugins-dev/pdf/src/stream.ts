/* 大小防线与流式来源支持：纯工具模块（不依赖 pdf.js，可独立契约测）。
   来源矩阵（探索笔记 04）：流式 URL 可达 → Range 流式；不可达（浏览器 mock / SMB zip
   复合路径）→ 整读；本地 zip 压缩条目流式 404 → 整读回退。
   两道大小防线都在整读之后按 bytes.length 事后判——宿主对 zip 条目整读无上限，
   插件自限是唯一防线（SMB 普通文件的 1GB 上限在宿主 smb::read_all，文案自带缓存提示）。 */

/** 宿主流式协议单响应 8MB 封顶（src-tauri stream.rs MAX_CHUNK），Range 拉取按此分块对齐 */
export const STREAM_CHUNK = 8 * 1024 * 1024;

/** 整读自限：zip 压缩条目等整读场景的插件侧上限 */
export const FULL_READ_LIMIT = 256 * 1024 * 1024;
/** 整读硬顶：超此体积一律拒开并提示先缓存到本地（SMB zip 条目 >1GB 语义） */
export const FULL_READ_HARD_LIMIT = 1024 * 1024 * 1024;

/** 整读大小防线：超限返回中文报错文案（toast 展示），可开返回 null */
export function fullReadSizeError(len: number): string | null {
  if (len > FULL_READ_HARD_LIMIT) return "文件超过 1 GB，不支持整读——请先缓存到本地再打开";
  if (len > FULL_READ_LIMIT) return "文件超过 256 MB，整读内存开销过大，已取消打开";
  return null;
}

/** bytes=0-0 探针：从 Content-Range 尾段取总字节数（ctx 无 stat API，这是正规途径）。
   非 206（压缩条目 404、协议/网络失败、不支持 Range 的服务器）一律抛错，调用方回退整读 */
export async function probeTotalSize(url: string): Promise<number> {
  const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (r.status !== 206) throw new Error(`流式不可用（HTTP ${r.status}）`);
  const m = /\/(\d+)\s*$/.exec(r.headers.get("Content-Range") ?? "");
  if (!m) throw new Error("流式响应缺少 Content-Range 总长");
  return Number(m[1]);
}

/** 拉取 [begin,end] 闭区间全量，返回恰好 end-begin+1 字节。按 STREAM_CHUNK 分块请求
   （对齐宿主协议 8MB 封顶）；服务器截断响应（返回少于请求）时从已收字节处续读，直到凑满 */
export async function fetchRange(url: string, begin: number, end: number): Promise<Uint8Array> {
  const total = end - begin + 1;
  const out = new Uint8Array(total);
  let got = 0;
  while (got < total) {
    const s = begin + got;
    const reqEnd = Math.min(end, s + STREAM_CHUNK - 1);
    const r = await fetch(url, { headers: { Range: `bytes=${s}-${reqEnd}` } });
    if (r.status !== 206) throw new Error(`Range 请求失败（HTTP ${r.status}）`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const n = Math.min(buf.length, total - got);
    if (n === 0) throw new Error("Range 响应为空");
    out.set(buf.subarray(0, n), got);
    got += n;
  }
  return out;
}
