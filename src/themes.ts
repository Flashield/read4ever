/* 配色方案定义与应用 */

export interface Theme {
  name: string;
  bg: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
}

/* 跨平台中文字体栈：Windows 字体名在前，macOS 对应字体兜底 */
export const FONT_SONG = `"SimSun","Songti SC",serif`;
export const FONT_YAHEI = `"Microsoft YaHei","PingFang SC",sans-serif`;
export const FONT_KAI = `"KaiTi","Kaiti SC","STKaiti",serif`;
export const FONT_FANGSONG = `"FangSong","STFangsong",serif`;
export const FONT_HEI = `"SimHei","Heiti SC",sans-serif`;

/* 外观面板字体下拉选项（跨平台） */
export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "宋体 / 明体", value: FONT_SONG },
  { label: "微软雅黑 / 苹方", value: FONT_YAHEI },
  { label: "楷体", value: FONT_KAI },
  { label: "仿宋", value: FONT_FANGSONG },
  { label: "黑体", value: FONT_HEI },
  { label: "系统默认", value: `system-ui,-apple-system,"Segoe UI",sans-serif` },
  { label: "Times New Roman", value: `"Times New Roman",Times,serif` },
  { label: "Serif", value: `Georgia,"Times New Roman",serif` },
  { label: "Sans-serif", value: `Verdana,Arial,sans-serif` },
];

/* 旧版本配置里存的裸 Windows 字体名 → 跨平台字体栈 */
const LEGACY_FONTS: Record<string, string> = {
  SimSun: FONT_SONG,
  NSimSun: FONT_SONG,
  "Microsoft YaHei": FONT_YAHEI,
  KaiTi: FONT_KAI,
  FangSong: FONT_FANGSONG,
  SimHei: FONT_HEI,
};

export function normalizeFontFamily(f: string): string {
  return LEGACY_FONTS[f] ?? f;
}

/* 内置十余种配色方案，参考 ReadBook 原版 */
export const BUILT_IN_THEMES: Theme[] = [
  { name: "白纸", bg: "#ffffff", text: "#000000", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "护眼绿", bg: "#c7edcc", text: "#333333", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "羊皮纸", bg: "#f5f0e0", text: "#5b4636", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "米黄", bg: "#faf3e0", text: "#4a4a4a", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "夜间黑", bg: "#1a1a1a", text: "#cccccc", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "深蓝夜读", bg: "#0d1b2a", text: "#b0c4de", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "纯黑夜读", bg: "#000000", text: "#888888", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "灰底", bg: "#d9d9d9", text: "#333333", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "棕褐", bg: "#3e2723", text: "#d7ccc8", fontFamily: FONT_KAI, fontSize: 18, lineSpacing: 1.8 },
  { name: "青瓷", bg: "#e0f2f1", text: "#004d40", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "淡粉", bg: "#fce4ec", text: "#4a4a4a", fontFamily: FONT_SONG, fontSize: 18, lineSpacing: 1.8 },
  { name: "深灰", bg: "#2b2b2b", text: "#b0b0b0", fontFamily: FONT_YAHEI, fontSize: 18, lineSpacing: 1.8 },
];

let currentTheme: Theme = { ...BUILT_IN_THEMES[2] };

export function getCurrentTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme): void {
  currentTheme = { ...theme };
  applyTheme(currentTheme);
}

export function applyTheme(theme: Theme): void {
  const content = document.getElementById("reader-content");
  const container = document.getElementById("reader-container");
  if (content) {
    content.style.background = theme.bg;
    content.style.color = theme.text;
    content.style.fontFamily = theme.fontFamily;
    content.style.fontSize = theme.fontSize + "px";
    content.style.lineHeight = String(theme.lineSpacing);
  }
  if (container) {
    container.style.background = theme.bg;
  }
  // 同时更新 CSS 变量供其他地方引用
  document.documentElement.style.setProperty("--reader-bg", theme.bg);
  document.documentElement.style.setProperty("--reader-text", theme.text);
}

export function findThemeByName(name: string, customThemes: Theme[] = []): Theme | undefined {
  return [...BUILT_IN_THEMES, ...customThemes].find((t) => t.name === name);
}

export function getAllThemeNames(customThemes: Theme[] = []): string[] {
  return [...BUILT_IN_THEMES, ...customThemes].map((t) => t.name);
}
