/* 主题跟随：外部插件不能 import 宿主模块——颜色读根元素 CSS 变量（applyTheme 会同时更新它们），
   字体/字号/行距读 #reader-content 的计算样式（applyTheme 直写内联样式）。
   watchTheme 监听两处 style 属性变化回调（换主题/换字体实时跟随）；返回解除函数。 */
export interface ThemeSnapshot {
  bg: string;
  text: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

export function readTheme(): ThemeSnapshot {
  const root = getComputedStyle(document.documentElement);
  const reader = document.getElementById("reader-content");
  const rc = reader ? getComputedStyle(reader) : null;
  return {
    bg: root.getPropertyValue("--reader-bg").trim() || "#f5f0e0",
    text: root.getPropertyValue("--reader-text").trim() || "#333333",
    fontFamily: rc?.fontFamily || "serif",
    fontSize: rc?.fontSize || "18px",
    lineHeight: rc?.lineHeight || "1.8",
  };
}

export function watchTheme(cb: () => void): () => void {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  const reader = document.getElementById("reader-content");
  if (reader) obs.observe(reader, { attributes: true, attributeFilter: ["style"] });
  return () => obs.disconnect();
}
