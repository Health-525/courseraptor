/**
 * 学校注册表：装配点只注册手动课表模式；registerSchool 幂等可覆盖
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 隔离：凭证与数据都指到临时目录，绝不碰真机 credentials.enc / data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-school-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
delete process.env.RAPTOR_SCHOOL;

test("装配后唯一注册的学校是手动课表模式（custom）", async () => {
  const { school } = await import("../src/core/school");
  await import("../src/adapters");
  assert.equal(school().info.id, "custom");
  assert.equal(school().info.manual, true);
});

test("registerSchool 幂等：重复注册同一实现不炸", async () => {
  const { registerSchool, school } = await import("../src/core/school");
  const before = school();
  registerSchool(before);
  assert.equal(school(), before);
});

test("RAPTOR_SCHOOL 残值不再被读取：装好的学校不受影响", async () => {
  // 旧版本支持 RAPTOR_SCHOOL 环境变量选校；现在唯一实现是 custom，
  // 存量 .env 里的旧值（如 njtech）被静默忽略，不拦启动
  const prev = process.env.RAPTOR_SCHOOL;
  process.env.RAPTOR_SCHOOL = "njtech";
  try {
    await import("../src/adapters");
    const { school } = await import("../src/core/school");
    assert.equal(school().info.id, "custom");
  } finally {
    if (prev === undefined) delete process.env.RAPTOR_SCHOOL;
    else process.env.RAPTOR_SCHOOL = prev;
  }
});
