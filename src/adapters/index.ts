/**
 * 学校适配器装配点（插件式）
 *
 * 入口文件（channels/cli、channels/qq、需要 school() 的测试）在顶部
 * `import "../../adapters"`（按相对深度调整）即可完成学校注册；
 * RAPTOR_SCHOOL 环境变量可强制指定实现。
 *
 * 插件模型：内置只保留 custom（「不接入任何学校」的手动课表兜底）；真实学校
 * 是可选插件——在 src/adapters/ 下建一个目录、导出一个 SchoolAdapter 即可，
 * 启动时被本文件自动扫描登记。插件目录默认不入库（见 src/adapters/README.md
 * 与 .gitignore），因此公开仓库 / CI 上没有真实学校代码时，装配点只登记
 * custom，编译与测试照常通过。
 *
 * 默认学校的取舍顺序：RAPTOR_SCHOOL 环境变量（开发者逃生舱）> 设置里
 * 保存的 schoolId（加密凭证，托管版每人一份、互不影响）> "custom"。
 *
 * 默认 custom＝「不接入任何学校」：不指向任何真实学校、零教务联网，
 * 课表靠手动导入。接入某所学校是用户在网页设置页「学校」栏里的
 * 显式选择，绝不默认接上。运行期切换走 core/school 的 selectSchool。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentialsStore } from "../core/credentials";
import {
  listSchoolOptions,
  registerSchoolOption,
  type SchoolAdapter,
  selectSchool,
} from "../core/school";
import { customSchool } from "./custom";

/** 内置适配器目录：随仓库分发、永远登记，不当插件重复扫描 */
const BUILTIN_DIRS = new Set(["custom"]);

const adaptersDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 从插件模块的导出里挑出 SchoolAdapter 形状的对象（不约束导出名）。
 * 认形状：有 info.id、capabilities 数组、terms——与 core/school 的端口一致。
 */
function pickAdapter(mod: Record<string, unknown>): SchoolAdapter | null {
  for (const value of Object.values(mod)) {
    const v = value as Partial<SchoolAdapter> | null | undefined;
    if (
      v &&
      typeof v === "object" &&
      typeof v.info?.id === "string" &&
      Array.isArray(v.capabilities) &&
      v.terms
    ) {
      return v as SchoolAdapter;
    }
  }
  return null;
}

/**
 * 扫描 src/adapters/ 下的插件目录（njtech 等，本地存在、不入库），用计算式
 * 动态 import 加载。计算式 specifier 令 tsc 无法静态解析——插件缺失（公开
 * 仓库 / CI）时既不报编译错、也不抛运行期错，只登记内置 custom。单个插件
 * 加载失败静默跳过，绝不拖垮其它适配器。
 */
async function loadSchoolPlugins(): Promise<void> {
  let names: string[];
  try {
    names = fs
      .readdirSync(adaptersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !BUILTIN_DIRS.has(d.name))
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const spec = `./${name}/index.ts`;
      const mod = (await import(spec)) as Record<string, unknown>;
      const adapter = pickAdapter(mod);
      if (adapter) registerSchoolOption(adapter);
    } catch {
      // 目录存在但非适配器 / 缺文件：跳过，不影响内置 custom
    }
  }
}

// 登记顺序即设置页的学校列表顺序：真实学校插件在前，「其他学校」custom 垫底。
await loadSchoolPlugins();
registerSchoolOption(customSchool);

export function installDefaultSchool(): void {
  const id = process.env.RAPTOR_SCHOOL ?? loadCredentialsStore()?.schoolId ?? "custom";
  if (!selectSchool(id)) {
    throw new Error(
      `未知学校适配器「${id}」：可用 ${listSchoolOptions()
        .map((a) => a.info.id)
        .join("、")}（RAPTOR_SCHOOL 环境变量指定）`,
    );
  }
}

installDefaultSchool();
