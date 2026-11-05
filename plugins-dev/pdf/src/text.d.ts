/* esbuild 以 loader ".txt"→text 打包的文本模块：pdf.js worker 源码副本（由构建脚本
   从 node_modules/pdfjs-dist 复制到 dist/，见 scripts/build-plugins.mjs）。
   "?raw" 变体：vite dev 直供 src 模块时的字符串包装后缀（esbuild 查询串不影响匹配）。 */
declare module "*.txt" {
  const text: string;
  export default text;
}
declare module "*.txt?raw" {
  const text: string;
  export default text;
}
