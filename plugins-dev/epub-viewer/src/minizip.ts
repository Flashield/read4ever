/* zip 中央目录只读解析（宿主 zipfile.rs 的 JS 翻版）：EOCD（含 ZIP64）→ 条目表 → 按需读取。
   仅支持常规 zip（epub 均满足）；压缩条目走 fflate inflateSync，stored 直接切片。 */
import { inflateSync } from "fflate";
import { decodeXml } from "../../_shared/decode";

export interface ZipEntry {
  name: string;
  method: number; // 0=stored 8=deflate
  compSize: number;
  size: number;
  localOffset: number;
}

export interface MiniZip {
  entries: Map<string, ZipEntry>;
  /** 读条目原始字节（LRU 缓存由调用方另行叠加） */
  read(name: string): Uint8Array;
  /** 读条目为文本（按 XML 声明/UTF-8） */
  readText(name: string): string;
}

const MAX_ENTRY = 64 * 1024 * 1024; // 单条目 64MB 上限

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number): number => u32(b, o) + u32(b, o + 4) * 0x100000000;
const UTF8 = new TextDecoder("utf-8");

export function parseZip(data: Uint8Array): MiniZip {
  // EOCD 自尾部回扫（定长 22 + 注释最长 65535）
  let eocd = -1;
  const scanStart = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= scanStart; i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/epub 文件（未找到目录尾）");
  let count = u16(data, eocd + 10);
  let cdOffset = u32(data, eocd + 16);
  // ZIP64：定位器在 EOCD 前 20 字节
  if (cdOffset === 0xffffffff || count === 0xffff) { // 宿主还查 cd_size 哨兵；>4GB 包必然同时置 offset/count 哨兵，此处等价
    const loc = eocd - 20;
    if (loc >= 0 && u32(data, loc) === 0x07064b50) {
      const z64 = u64(data, loc + 8);
      if (u32(data, z64) === 0x06064b50) {
        count = u64(data, z64 + 32);
        cdOffset = u64(data, z64 + 48);
      }
    }
  }
  if (count > 1_048_576) throw new Error("zip 条目数异常");

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(data, p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = u16(data, p + 10);
    let compSize = u32(data, p + 20);
    let size = u32(data, p + 24);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    let localOffset = u32(data, p + 42);
    const name = UTF8.decode(data.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 扩展字段：仅对 0xFFFFFFFF 的字段按 size→compSize→offset 顺序补读
    if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let q = p + 46 + nameLen;
      const qEnd = q + extraLen;
      while (q + 4 <= qEnd) {
        const id = u16(data, q);
        const sz = u16(data, q + 2);
        if (id === 0x0001) {
          let f = q + 4;
          if (size === 0xffffffff) {
            size = u64(data, f);
            f += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = u64(data, f);
            f += 8;
          }
          if (localOffset === 0xffffffff) localOffset = u64(data, f);
          break;
        }
        q += 4 + sz;
      }
    }
    if (!name.endsWith("/")) entries.set(name, { name, method, compSize, size, localOffset }); // 重名条目取最后一条（宿主取第一条；规范包无重名）
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name: string): Uint8Array => {
    const e = entries.get(name);
    if (!e) throw new Error(`epub 内缺少文件: ${name}`);
    if (e.size > MAX_ENTRY) throw new Error(`条目过大（${(e.size / 1048576).toFixed(0)}MB）: ${name}`);
    if (u32(data, e.localOffset) !== 0x04034b50) throw new Error(`zip 本地头损坏: ${name}`);
    const nameLen = u16(data, e.localOffset + 26);
    const extraLen = u16(data, e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (start + e.compSize > data.length) throw new Error(`条目数据不完整: ${name}`);
    const raw = data.subarray(start, start + e.compSize);
    if (e.method === 0) return raw.slice(); // slice 脱离原大缓冲，避免整包长期驻留
    if (e.method === 8) return inflateSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  };
  return { entries, read, readText: (n) => decodeXml(read(n)) };
}
