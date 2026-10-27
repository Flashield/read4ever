/* 屏幕常亮来源聚合（docs/屏幕常亮方案.md）。
   前端聚合而非 Rust 计数：后端只需一个幂等总开关，浏览器演示天然 no-op。
   规则：来源集合非空 且 用户设置开启 → 后端开；否则关。谁最后结束谁关灯。 */
import { api } from "./api";

const sources = new Set<string>();
let enabled = true; // 用户设置（app 启动与菜单切换时同步）
let backendOn = false; // 后端当前状态，去重用

function sync(): void {
  const want = enabled && sources.size > 0;
  if (want === backendOn) return;
  backendOn = want;
  api.setKeepAwake(want).catch((e) => console.warn("[keepawake]", e));
}

/** 持有/释放一个常亮来源（阅读侧 "reading"；插件侧 "plugin:<id>"）。幂等。 */
export function holdAwake(source: string, on: boolean): void {
  const had = sources.has(source);
  if (on === had) return;
  if (on) sources.add(source);
  else sources.delete(source);
  sync();
}

/** 清掉某插件的常亮来源（视图关闭时宿主兜底，防外部插件忘关导致永久常亮） */
export function releasePluginAwake(pluginId: string): void {
  if (sources.delete(`plugin:${pluginId}`)) sync();
}

/** 用户设置开关：翻转标志并强制同步（来源集合保留，重新开启后按当前来源恢复） */
export function setKeepAwakeEnabled(v: boolean): void {
  if (enabled === v) return;
  enabled = v;
  sync();
}
