/**
 * 给 @ai-sdk/tui 打启动欢迎页补丁。
 *
 * 库的空状态只有一行 "Waiting for input..."，全屏卡片中间大片留白。
 * 这里把空状态改成读 globalThis.__raptorWelcome（string[]，应用侧可
 * 随时更新、每次重绘都会重新读取），未设置时回退到内置静态欢迎页。
 * 应用侧见 src/tui/welcome.ts：启动后后台拉取今日课表/最新通知/GPA
 * 逐段刷新面板。
 *
 * 幂等：检测到已打补丁（无论新旧版本）时按需升级或静默跳过。
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
  dim("快捷键：ESC 打断回复 · Ctrl+C 退出 · ↑/↓ 滚动"),
];
// 补丁后的空状态：优先用应用注入的实时面板，没注入就用静态欢迎页
// （锚点分组已含 "return "，这里只给表达式）
const replacement = `(globalThis.__raptorWelcome ?? ${JSON.stringify(fallbackLines)});`;

let source;
try {
  source = readFileSync(distPath, "utf8");
} catch {
  console.error(`[patch-tui] 找不到 ${distPath}，跳过（依赖未安装？）`);
  process.exit(0);
}

if (source.includes("globalThis.__raptorWelcome")) {
  process.exit(0); // 已是新版补丁
}

// 空状态 return 的位置在 `_sections.length === 0` 分支里，
// 原版和旧版补丁只有 return 的内容不同，统一按这个锚点替换
const anchor = new RegExp("(_sections\\)\\.length === 0\\) \\{\\n\\s*return )[^;]+;");
const patched = source.replace(anchor, `$1${replacement}`);
if (patched === source) {
  console.error("[patch-tui] 未匹配到原始空状态代码，@ai-sdk/tui 可能已升级，跳过");
  process.exit(0);
}

writeFileSync(distPath, patched);
console.log("[patch-tui] @ai-sdk/tui 启动欢迎页补丁完成");
