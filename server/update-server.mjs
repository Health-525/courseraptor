#!/usr/bin/env node
/**
 * CourseRaptor 更新服务入口。
 *
 * 运行：
 *   UPDATE_ADMIN_TOKEN=管理员密钥 PORT=8787 \
 *     node server/update-server.mjs
 *
 * 数据写入 update-data/：
 * - meta.json + 版本 zip：更新分发。
 */

import { createUpdateServer } from "./app.mjs";

const port = Number(process.env.PORT) || 8787;
// 公网入口必须由 Nginx/Caddy 终止 HTTPS；Node 服务默认不直接暴露到互联网。
const host = process.env.HOST || "127.0.0.1";

try {
  const server = createUpdateServer({
    adminToken: process.env.UPDATE_ADMIN_TOKEN,
  });
  server.listen(port, host, () => {
    console.log(`✅ 更新后台已启动：http://${host}:${port}`);
    console.log("   同学下载/更新  GET  /download");
    console.log("   发新版          POST /publish（x-admin-token + x-version + zip 包体）");
  });
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  console.error("请设置 UPDATE_ADMIN_TOKEN。");
  process.exit(1);
}
