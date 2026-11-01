/* 路径工具：zip 复合路径（"zip路径::条目名"）感知的目录切分与相对路径解析。
   ZIP_RE 与宿主 src/plugins/registry.ts 的 splitTarget 正则保持一致（改一处须同步另一处）。 */
const ZIP_RE = /^(.+\.zip)::(.*)$/i;

/** 目录部分（zip 复合路径保留 "zip::目录" 前缀；根目录原样返回） */
export function dirOf(path: string): string {
  const m = path.match(ZIP_RE);
  if (m) {
    const i = Math.max(m[2].lastIndexOf("/"), m[2].lastIndexOf("\\"));
    return i > 0 ? `${m[1]}::${m[2].slice(0, i)}` : `${m[1]}::`;
  }
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/** 文件名部分（zip 复合路径取条目名） */
export function baseOf(path: string): string {
  const m = path.match(ZIP_RE);
  const s = m ? m[2] : path;
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

/** 段式相对路径解析：dir 为目录段（无 zip 复合前缀），rel 支持 ../ ./ 与 URL 解码 */
function resolveSegs(dir: string, rel: string): string {
  let r = rel;
  try {
    r = decodeURIComponent(rel);
  } catch {
    /* 已是原始字符：保持 */
  }
  const segs = dir ? dir.split(/[\\/]/).filter(Boolean) : [];
  for (const part of r.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

/** 在基础目录（dirOf 的产物，可含 "zip::" 复合前缀）下解析相对路径 rel */
export function resolveUnder(dir: string, rel: string): string {
  const m = dir.match(ZIP_RE);
  if (m) return `${m[1]}::${resolveSegs(m[2], rel)}`;
  const p = resolveSegs(dir, rel);
  // 绝对路径根在段式解析中被丢弃，这里补回（盘符形式段式 join 已自带 C:/ 前缀）
  if (/^[A-Za-z]:/.test(p)) return p;
  return dir.startsWith("/") || dir.startsWith("\\") ? `/${p}` : p;
}
