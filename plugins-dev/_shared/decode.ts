/* 编码探测（宿主 encoding.rs 的前端轻量版）：BOM → UTF-8 严格 → GBK 回退 */
export function decodeText(bytes: Uint8Array): { text: string; label: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(bytes), label: "UTF-16LE" };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(bytes), label: "UTF-16BE" };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), label: "UTF-8" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), label: "UTF-8" };
  } catch {
    return { text: new TextDecoder("gbk").decode(bytes), label: "GBK" };
  }
}

/** XML/XHTML 解码：按声明标签（前 512 字节内）取编码，未知或缺失回退 UTF-8 */
export function decodeXml(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 512));
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  if (m) {
    try {
      return new TextDecoder(m[1]).decode(bytes);
    } catch {
      /* 未知编码标签：回退 UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
