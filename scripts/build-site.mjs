/** 只把明确公开的网站文件复制进 dist，不加载配置或运行数据。 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = ["index.html", "landing.css", "landing.js", "courseraptor-logo.png", "screenshot-demo.jpg", "social-preview.jpg", ".nojekyll"];
const output = path.join(root, "dist");
mkdirSync(output, { recursive: true });
const html = readFileSync(path.join(root, "docs/index.html"), "utf8");
for (const [, link] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  if (!link.startsWith("#") && !/^https?:\/\//.test(link) && !assets.includes(link)) throw new Error(`未列入构建清单的链接：${link}`);
}
for (const file of assets) copyFileSync(path.join(root, "docs", file), path.join(output, file));
console.log(`Landing Page 构建完成：${assets.length} 个公开文件 → dist/`);
