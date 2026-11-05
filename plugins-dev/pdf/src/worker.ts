/* pdf.js worker 装配：blob 自启动（不依赖宿主 vite 配置），模块级复用。
   自 main.ts 迁出：main.ts 与 transport.ts（流式打开）共用，重复调用无害。 */
import "./shims"; // 必须最先 import：垫片先于 pdfjs-dist 模块体求值
import * as pdfjsLib from "pdfjs-dist";
/* ?raw：vite dev 直供 src 模块时按字符串包装（esbuild 侧查询串不参与 loader 匹配，仍走 .txt=text） */
import workerText from "../dist/pdf.worker.min.mjs.txt?raw";

let workerUrl = ""; // worker 从 blob 实例化后 URL 即无存在必要，保留给后续打开复用

/* pdf.js 6.5 直接依赖 2025 年新入库的 ES 方法（Map upsert、Uint8Array 二进制扩展、
   Promise.withResolvers、Set.intersection、Math.sumPrecise——加密解密路径必经）且不带垫片，
   旧内核没有会整体解析失败——以 prologue 前置进 worker blob 补齐（与 src/shims.ts 同一组垫片，
   保持同步）。 */
const WORKER_PROLOGUE = `
function rbUpsert(p){Object.assign(p,{getOrInsert:function(k,v){if(!this.has(k))this.set(k,v);return this.get(k)},getOrInsertComputed:function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)}})}
if(!Map.prototype.getOrInsert)rbUpsert(Map.prototype);
if(!WeakMap.prototype.getOrInsert)rbUpsert(WeakMap.prototype);
if(!Uint8Array.prototype.toHex){Uint8Array.prototype.toHex=function(){let s='';for(const b of this)s+=b.toString(16).padStart(2,'0');return s}}
if(!Uint8Array.prototype.toBase64){Uint8Array.prototype.toBase64=function(){let s='';for(let i=0;i<this.length;i+=32768)s+=String.fromCharCode.apply(null,this.subarray(i,i+32768));return btoa(s)}}
if(!Uint8Array.fromBase64){Uint8Array.fromBase64=function(s){const b=atob(String(s).replace(/\\s+/g,''));const o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o}}
if(!Set.prototype.intersection){Set.prototype.intersection=function(o){const t=this.size<=o.size?this:o,b=t===this?o:this,n=new Set();for(const v of t)if(b.has(v))n.add(v);return n}}
if(!Promise.withResolvers){Promise.withResolvers=function(){let r,j;const p=new Promise(function(a,b){r=a;j=b});return{promise:p,resolve:r,reject:j}}}
if(!Math.sumPrecise){Math.sumPrecise=function(v){let s=0;for(const x of v)s+=x;return s}}
`;

/** worker 以 blob 自启动（同源 blob URL 直接可用，无需宿主任何资源路径）；幂等 */
export function ensureWorker(): void {
  if (!workerUrl)
    workerUrl = URL.createObjectURL(new Blob([WORKER_PROLOGUE + workerText], { type: "text/javascript" }));
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}
