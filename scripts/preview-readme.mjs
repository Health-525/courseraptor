#!/usr/bin/env node
/** 本机文档预览：只读取明确的 Markdown/品牌素材，不加载个人配置。 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { marked } from "marked";

const root = fileURLToPath(new URL("../", import.meta.url));
const markdown = new Set(["README.md", "README.en.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md",
  "docs/student-guide.md", "docs/configuration.md", "docs/capabilities.md", "docs/roadmap.md",
  "docs/promotion.md", "docs/maintainers.md", "docs/github-best-practices.md"]);
const images = new Set(["docs/hero-banner.png", "docs/social-preview.jpg", "docs/screenshot-demo.jpg", "docs/courseraptor-logo.png"]);
const css = `body{margin:0;background:#f6f8fa;color:#1f2328;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}article{box-sizing:border-box;max-width:1012px;margin:32px auto;padding:40px;border:1px solid #d1d9e0;border-radius:10px;background:white}img{max-width:100%;height:auto}h1,h2{line-height:1.3;border-bottom:1px solid #d1d9e0;padding-bottom:.3em}h2{margin-top:32px}h3{line-height:1.4}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}table{border-collapse:collapse;max-width:100%;margin:16px 0}th,td{border:1px solid #d1d9e0;padding:12px 16px}tr:nth-child(even){background:#f6f8fa}pre{padding:16px;background:#f6f8fa;border-radius:6px;overflow:auto}code{font-family:Consolas,monospace}p code,li code{background:#eff1f3;padding:2px 5px;border-radius:4px}blockquote{border-left:4px solid #79c6ab;margin:20px 0;padding:0 16px;color:#59636e}summary{cursor:pointer}hr{border:0;border-top:1px solid #d1d9e0;margin:24px 0}@media(max-width:600px){article{padding:16px;margin:0;border:0}td{padding:8px}h3{font-size:17px}}`;
http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const name = url === "/" ? "README.md" : url.slice(1);
  try {
    if (url === "/social") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>CourseRaptor 社交预览图</title><style>html,body{margin:0;width:1280px;height:640px;overflow:hidden;background:#071b30}img{display:block;width:1280px;height:640px}</style></head><body><img src="/docs/hero-banner.png" alt="CourseRaptor 教务琐事，一句话。"></body></html>');
    } else if (images.has(name)) {
      const data = readFileSync(path.join(root, name));
      res.writeHead(200, { "content-type": name.endsWith(".jpg") ? "image/jpeg" : "image/png" });
      res.end(data);
    } else if (markdown.has(name)) {
      const content = readFileSync(path.join(root, name), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // 相对链接以仓库根为准；该预览只面向本项目维护者。
      const base = name.startsWith("docs/") ? "/docs/" : "/";
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${base}"><title>CourseRaptor README 预览</title><style>${css}</style></head><body><article>${marked.parse(content)}</article></body></html>`);
    } else { res.writeHead(404); res.end("Not found"); }
  } catch { res.writeHead(500); res.end("Preview asset unavailable"); }
}).listen(3212, "127.0.0.1", () => console.log("README 预览：http://127.0.0.1:3212"));
