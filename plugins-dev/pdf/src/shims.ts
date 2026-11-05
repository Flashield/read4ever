/* pdf.js 6.5 依赖 2025 年才进引擎的新方法且不带垫片，旧内核（WebView2/WKWebView 落后版本）
   会缺方法导致文档整体解析失败：Map/WeakMap upsert（getOrInsert/getOrInsertComputed）、
   二进制扩展（Uint8Array.toHex/toBase64/fromBase64）、Promise.withResolvers、Set.intersection、
   Math.sumPrecise（加密解密路径必经）。
   本模块必须先于 pdfjs-dist import（esbuild 按依赖序求值）；worker 是独立上下文，
   构建期由 scripts/build-plugins.mjs 把本模块整体编译为 IIFE 文本（dist/shims.gen.txt），
   worker.ts 拼进 worker blob 前部——单一实现，宿主与 worker 两个上下文共用，无需手工同步。 */

function installUpserts(proto: object): void {
  Object.defineProperty(proto, "getOrInsert", {
    value: function (this: Map<unknown, unknown>, key: unknown, value: unknown): unknown {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(proto, "getOrInsertComputed", {
    value: function (this: Map<unknown, unknown>, key: unknown, fn: (k: unknown) => unknown): unknown {
      if (!this.has(key)) this.set(key, fn(key));
      return this.get(key);
    },
    writable: true,
    configurable: true,
  });
}

/* pdf.js 对 Map 与 WeakMap 两类接收者都有调用（如 CanvasGraphics 的静态 #pathCaches 是 WeakMap） */
if (!(Map.prototype as { getOrInsert?: unknown }).getOrInsert) installUpserts(Map.prototype);
if (!(WeakMap.prototype as { getOrInsert?: unknown }).getOrInsert) installUpserts(WeakMap.prototype);

if (typeof (Uint8Array.prototype as { toHex?: unknown }).toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value: function (this: Uint8Array): string {
      let s = "";
      for (const b of this) s += b.toString(16).padStart(2, "0");
      return s;
    },
    writable: true,
    configurable: true,
  });
}

if (typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: function (this: Uint8Array): string {
      let s = "";
      for (let i = 0; i < this.length; i += 0x8000)
        s += String.fromCharCode(...this.subarray(i, i + 0x8000));
      return btoa(s);
    },
    writable: true,
    configurable: true,
  });
}

if (typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 !== "function") {
  Object.defineProperty(Uint8Array, "fromBase64", {
    value: (s: string): Uint8Array => {
      const bin = atob(String(s).replace(/\s+/g, ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
    writable: true,
    configurable: true,
  });
}

if (typeof (Set.prototype as { intersection?: unknown }).intersection !== "function") {
  Object.defineProperty(Set.prototype, "intersection", {
    value: function (this: Set<unknown>, other: Set<unknown>): Set<unknown> {
      const small = this.size <= other.size ? this : other;
      const big = small === this ? other : this;
      const out = new Set();
      for (const v of small) if (big.has(v)) out.add(v);
      return out;
    },
    writable: true,
    configurable: true,
  });
}

if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    value: function <T>(): {
      promise: Promise<T>;
      resolve: (v: T) => void;
      reject: (e: unknown) => void;
    } {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
    writable: true,
    configurable: true,
  });
}

/* Math.sumPrecise（ES2025）：pdf.js 加密解密路径（哈希分支选择）与字体/xref 尺寸计算必经；
   这些场景全是整数求和，朴素累加精确等价 */
if (typeof (Math as { sumPrecise?: unknown }).sumPrecise !== "function") {
  Object.defineProperty(Math, "sumPrecise", {
    value: function (values: Iterable<number>): number {
      let sum = 0;
      for (const v of values) sum += v;
      return sum;
    },
    writable: true,
    configurable: true,
  });
}
