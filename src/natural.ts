/* 文件名自然排序比较器（src-tauri/src/natural.rs natural_cmp 的逐段镜像）。
   按 ASCII 数字切段：数字段按数值比（BigInt 精确值，超过 u64 时与 Rust 同款
   钳到 u64::MAX；数值相等时段短者在前，即前导零少者靠前），非数字段按
   toLowerCase 后的码元序比，数字段先于非数字段；全部逐段等价时按整串码元序
   兜底。已知仅存分歧：同时含增补平面字符（≥U+10000）与 U+E000–U+FFFF 字符的
   串，UTF-16 码元序与 Rust 的 UTF-8 字节序可能不同，文件名场景可忽略。 */

const U64_MAX = (1n << 64n) - 1n;

export function naturalCompare(a: string, b: string): number {
  let sa = a;
  let sb = b;
  for (;;) {
    const ra = nextSegment(sa);
    const rb = nextSegment(sb);
    if (ra === null && rb === null) return a < b ? -1 : a > b ? 1 : 0;
    if (ra === null) return -1;
    if (rb === null) return 1;
    const [xa, da] = ra;
    const [xb, db] = rb;
    let ord: number;
    if (da && db) {
      const na = clampU64(xa);
      const nb = clampU64(xb);
      ord = na < nb ? -1 : na > nb ? 1 : xa.length - xb.length;
    } else if (da !== db) {
      ord = da ? -1 : 1; // 数字段先于非数字段
    } else {
      const la = xa.toLowerCase();
      const lb = xb.toLowerCase();
      ord = la < lb ? -1 : la > lb ? 1 : 0;
    }
    if (ord !== 0) return ord;
    sa = sa.slice(xa.length);
    sb = sb.slice(xb.length);
  }
}

/** 超过 u64 的数字段钳到 u64::MAX，与 Rust 侧 parse::<u64>().unwrap_or(u64::MAX) 对齐 */
function clampU64(s: string): bigint {
  const v = BigInt(s);
  return v > U64_MAX ? U64_MAX : v;
}

/** 切出首段：[段, 是否 ASCII 数字段]；s 为空返回 null（镜像 Rust next_segment） */
function nextSegment(s: string): [string, boolean] | null {
  if (!s) return null;
  const digit = s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;
  let end = s.length;
  for (let i = 1; i < s.length; i++) {
    if ((s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) !== digit) {
      end = i;
      break;
    }
  }
  return [s.slice(0, end), digit];
}
