/* esbuild 以 loader ".txt"→text 打包的文本模块：pdf.js worker 源码副本（由构建脚本
   从 node_modules/pdfjs-dist 复制到 dist/，见 scripts/build-plugins.mjs）。 */
declare module "*.txt" {
  const text: string;
  export default text;
}
