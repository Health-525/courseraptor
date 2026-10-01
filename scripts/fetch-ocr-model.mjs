#!/usr/bin/env node
/** 预取 tesseract.js 的英文 OCR 模型到项目根（eng.traineddata）。
 * 模型本由 tesseract.js 在首次验证码识别时按需下载并缓存在工作目录；
 * 打包策略（scripts/package-policy.mjs）会把它带进安装包让同学离线可用。
 * 本脚本让维护者在干净机器上无需先触发一次验证码识别即可备齐打包输入。
 * 下载地址与 tesseract.js@7 未显式配置 langPath 时的默认 CDN 完全一致。 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz";
const MIN_SIZE = 1_000_000;
const target = path.join(fileURLToPath(new URL("../", import.meta.url)), "eng.traineddata");
const force = process.argv.includes("--force");

if (existsSync(target) && !force) {
  console.log(`eng.traineddata 已存在，跳过下载（--force 可强制重取）`);
  process.exit(0);
}

console.log(`下载 ${MODEL_URL} …`);
let resp;
try {
  resp = await fetch(MODEL_URL);
} catch (e) {
  console.error(`下载失败：${e?.message ?? e}`);
  console.error("可稍后重试，或检查网络对 cdn.jsdelivr.net 的访问。");
  process.exit(1);
}
if (!resp.ok) {
  console.error(`下载失败：HTTP ${resp.status}`);
  process.exit(1);
}
const packed = Buffer.from(await resp.arrayBuffer());
if (packed.length < 1024) {
  console.error(`下载内容异常（仅 ${packed.length} 字节），已放弃写入。`);
  process.exit(1);
}
// CDN 提供 gzip 压缩包（与 tesseract.js 的 gzip 默认一致）；按魔数判断再解压
const isGzip = packed[0] === 0x1f && packed[1] === 0x8b;
const model = isGzip ? gunzipSync(packed) : packed;
if (model.length < MIN_SIZE) {
  console.error(`模型体积异常（${model.length} 字节），已放弃写入。`);
  process.exit(1);
}
writeFileSync(target, model);
console.log(`已写入 ${target}（${model.length} 字节）`);
