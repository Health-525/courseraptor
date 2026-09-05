/** 静态宣传页预览，仅提供明确的网站文件，不暴露项目目录。 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/landing.css", ["landing.css", "text/css; charset=utf-8"]],
  ["/landing.js", ["landing.js", "text/javascript; charset=utf-8"]],
  ["/courseraptor-logo.png", ["courseraptor-logo.png", "image/png"]],
  ["/screenshot-demo.jpg", ["screenshot-demo.jpg", "image/jpeg"]],
  ["/social-preview.jpg", ["social-preview.jpg", "image/jpeg"]],
]);
http.createServer(async (req, res) => {
  const file = files.get((req.url ?? "/").split("?")[0]);
  if (!file || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end("Not found"); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(`../docs/${file[0]}`, import.meta.url)));
    res.writeHead(200, { "Content-Type": file[1], "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { res.writeHead(500); res.end("Site asset unavailable"); }
}).listen(3213, "127.0.0.1", () => console.log("Landing Page 预览：http://127.0.0.1:3213"));
