/**
 * 给 @ai-sdk/tui 打应用级补丁。幂等，每个补丁独立检测、可按需升级：
 *
 * 1. 启动欢迎页：库的空状态只有一行 "Waiting for input..."，改成读
 *    globalThis.__raptorWelcome（string[]，应用侧随时更新、每次重绘重读）。
 *    应用侧见 src/tui/welcome.ts：启动后后台拉今日课表/最新通知逐段刷新。
 *
 * 2. 斜杠命令菜单：帧渲染读 globalThis.__raptorSlashMenu（string[]，应用侧
 *    src/tui/slash-menu.ts），非空时插到正文框与输入框之间，同时把正文高度
 *    让给菜单，保证总行数恒等于终端高度（帧 diff 与清屏重绘都不出格）。
 *    选中项变化不经过库的按键管线，应用侧 emit stdout 的 resize 触发库全帧
 *    重绘（库的重绘只挂在这个事件上）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// 包主入口就是 dist/index.js
const distPath = fileURLToPath(pathToFileURL(require.resolve("@ai-sdk/tui")));

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const fallbackLines = [
  dim("欢迎使用 CourseRaptor 🦖 — NJTECH 教务 Agent"),
  "",
  dim("可以直接问："),
  dim("  这周课表 · 最近通知 · 我的成绩 · 通识还差哪几类"),
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
  // 空状态 return 的位置在 `_sections.length === 0` 分支里，
  // 原版和旧版补丁只有 return 的内容不同，统一按这个锚点替换
  // （锚点分组已含 "return "，这里只给表达式）
  const anchor = new RegExp("(_sections\\)\\.length === 0\\) \\{\\n\\s*return )[^;]+;");
  const next = patched.replace(anchor, `$1(globalThis.__raptorWelcome ?? ${JSON.stringify(fallbackLines)});`);
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
