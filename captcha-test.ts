import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
/** 实验：验证码下载链路 + OCR 识别 */
import fs from "node:fs/promises";

const ATT_URL = "https://jwc.njtech.edu.cn/system/_content/download.jsp?urltype=news.DownloadAttachUrl&owner=1924075572&wbfileid=18199927";

// 手动 cookie 管理（验证码存在 session，必须同 cookie）
let cookie = "";

async function get(url: string): Promise<{ buf: Buffer; type: string; setCookie: string[] }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", ...(cookie ? { Cookie: cookie } : {}) },
    redirect: "manual",
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const kv = c.split(";")[0];
    const key = kv.split("=")[0];
    cookie = cookie
      .split("; ").filter((x) => !x.startsWith(key + "="))
      .concat(kv)
      .join("; ");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get("content-type") || "", setCookie: sc };
}

// 1. 首次请求 -> 验证码页
const p1 = await get(ATT_URL);
console.log("首次请求:", p1.type, p1.buf.length, "字节，cookie:", cookie.slice(0, 50));

// 2. 验证码图片
const img = await get("https://jwc.njtech.edu.cn/system/resource/js/filedownload/createimage.jsp?randnum=" + Date.now());
console.log("验证码图:", img.type, img.buf.length, "字节");
await fs.writeFile("captcha.png", img.buf);

// 3. OCR
const tesseract = require("tesseract.js") as typeof import("tesseract.js");
const { data } = await tesseract.recognize(img.buf, "eng", {
  tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyz",
});
const code = data.text.replace(/\s+/g, "");
console.log("OCR 识别:", JSON.stringify(code));

// 4. 带 codeValue 下载
const p2 = await get(ATT_URL + "&codeValue=" + encodeURIComponent(code));
console.log("下载结果:", p2.type, p2.buf.length, "字节");
console.log(p2.type.includes("html") ? "仍是验证码页（识别错误或链路不对）" : "✅ 拿到真文件！");
