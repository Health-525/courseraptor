#!/usr/bin/env node
/**
 * CourseRaptor 更新与授权服务入口。
 *
 * 运行：
 *   UPDATE_ADMIN_TOKEN=管理员密钥 LICENSE_SECRET=授权哈希密钥 PORT=8787 \
 *     node server/update-server.mjs
 *
 * 数据写入 update-data/：
 * - meta.json + 版本 zip：更新分发；
 * - licenses.sqlite：密钥哈希、状态、设备绑定（不保存明文密钥和教务数据）。
 */

import { createUpdateServer } from "./app.mjs";

const port = Number(process.env.PORT) || 8787;
// 公网入口必须由 Nginx/Caddy 终止 HTTPS；Node 服务默认不直接暴露到互联网。
const host = process.env.HOST || "127.0.0.1";

try {
  const server = createUpdateServer({
    adminToken: process.env.UPDATE_ADMIN_TOKEN,
    licenseSecret: process.env.LICENSE_SECRET,
  });
  server.listen(port, host, () => {
    console.log(`✅ 更新与授权后台已启动：http://${host}:${port}`);
    console.log("   同学下载/更新  GET  /download（客户端携带已激活的密钥）");
    console.log("   客户端激活      POST /license/activate");
    console.log("   授权管理页面    GET  /admin");
    console.log("   发新版          POST /publish（x-admin-token + x-version + zip 包体）");
  });
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  console.error("请设置 UPDATE_ADMIN_TOKEN 和至少 16 位的 LICENSE_SECRET。");
  process.exit(1);
}
