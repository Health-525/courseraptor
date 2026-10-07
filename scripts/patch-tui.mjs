/**
 * 给 @ai-sdk/tui 打应用级补丁。幂等，每个补丁独立检测、可按需升级：
 *
 * 1. 启动欢迎页：库的空状态只有一行 "Waiting for input..."，改成读
 *    globalThis.__raptorWelcome（string[]，应用侧随时更新、每次重绘重读）。
 *    应用侧见 local/cli/tui/welcome.ts：启动后后台拉今日课表/最新通知逐段刷新。
 *
 * 2. 斜杠命令菜单：帧渲染读 globalThis.__raptorSlashMenu（string[]，应用侧
 *    local/cli/tui/slash-menu.ts），非空时插到正文框与输入框之间，同时把正文高度
 *    让给菜单，保证总行数恒等于终端高度（帧 diff 与清屏重绘都不出格）。
 *    选中项变化不经过库的按键管线，应用侧 emit stdout 的 resize 触发库全帧
 *    重绘（库的重绘只挂在这个事件上）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// 包主入口就是 dist/index.js
const distPath = fileURLToPath(pathToFileURL(require.resolve("@ai-sdk/tui")));

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const fallbackLines = [
  dim("欢迎使用 CourseRaptor 🦖 — 本地学习助理"),
  "",
  dim("可以直接问："),
  dim("  这周课表 · 我的待办 · 我记过哪些知识 · 有哪些要注意的"),
  "",
  dim("快捷键：滚轮/↑↓ 滚动 · ESC 打断回复 · Ctrl+C 退出 · 输入 / 唤出命令菜单"),
];

let source;
try {
  source = readFileSync(distPath, "utf8");
} catch {
  console.error(`[patch-tui] 找不到 ${distPath}，跳过（依赖未安装？）`);
  process.exit(0);
}

let patched = source;
const applied = [];

// ── 补丁 1：欢迎页 ────────────────────────────────────────────
if (!source.includes("globalThis.__raptorWelcome")) {
  // 空状态只 return 一行 "Waiting for input..."。锚点不能用 `_sections).length`
  // 这类私有字段写法：1.0.112 是 __privateGet(this, _sections)、1.0.117 起改为
  // 原生 this.#sections，写法变过一轮导致补丁静默失效；按返回值字面量定位，
  // 新旧 dist 都含这一行且全文件唯一。
  const anchor = /return \["Waiting for input\.\.\."\];/;
  const next = patched.replace(
    anchor,
    `return (globalThis.__raptorWelcome ?? ${JSON.stringify(fallbackLines)});`,
  );
  if (next !== patched) {
    patched = next;
    applied.push("欢迎页");
  } else {
    console.error("[patch-tui] 欢迎页锚点未匹配，@ai-sdk/tui 可能已升级，跳过该项");
  }
}

// ── 补丁 2：斜杠命令菜单 ─────────────────────────────────────
if (!source.includes("globalThis.__raptorSlashMenu")) {
  // 正文高度让位给菜单，总行数保持 = height
  const heightAnchor = "const bodyHeight = height - inputHeight;";
  const heightPatch =
    "const bodyHeight = height - inputHeight - " +
    "(globalThis.__raptorSlashMenu ? globalThis.__raptorSlashMenu.length : 0);";
  // 菜单行插在正文框底边与输入框顶边之间
  const linesAnchor =
    'bottomBorder(width),\n    topBorder(width, state.inputActive ? "Input" : "Status"),';
  const linesPatch =
    "bottomBorder(width),\n" +
    "    ...(globalThis.__raptorSlashMenu != null ? globalThis.__raptorSlashMenu : []),\n" +
    '    topBorder(width, state.inputActive ? "Input" : "Status"),';
  if (patched.includes(heightAnchor) && patched.includes(linesAnchor)) {
    patched = patched.replace(heightAnchor, heightPatch).replace(linesAnchor, linesPatch);
    applied.push("斜杠命令菜单");
  } else {
    console.error("[patch-tui] 菜单锚点未匹配，@ai-sdk/tui 可能已升级，跳过该项");
  }
}

if (patched === source) {
  if (applied.length) process.exit(0); // 理论不可达（applied 非空必有变化）
  console.log("[patch-tui] @ai-sdk/tui 补丁已就位，无需更新");
  process.exit(0);
}

writeFileSync(distPath, patched);
console.log(`[patch-tui] @ai-sdk/tui 补丁完成：${applied.join("、") || "未知项"}`);
