/**
 * njtech 插件探针（测试辅助）
 *
 * njtech 是可选的本地学校插件，默认不入库（见 src/adapters/README.md）。
 * 公开仓库 / CI 上没有 njtech 源码，依赖它的测试必须优雅跳过而不是崩：
 * - 直接 import njtech 模块的单测 → 随插件本地化，根本不入库；
 * - 只把 njtech 当「真实学校」夹具的框架级测试 → 用本探针的 HAS_NJTECH
 *   把相关 test 降级成 test.skip，并让选项清单等断言按有无 njtech 分支。
 *
 * 判定用文件系统存在性（而非注册表），以便在设置 RAPTOR_SCHOOL=njtech 并
 * import 装配点之前就决定要不要跳过——否则缺插件时 installDefaultSchool 会抛错。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 本地是否安装了 njtech 学校插件（公开仓库 / CI 上为 false） */
export const HAS_NJTECH: boolean = fs.existsSync(
  path.join(here, "../../src/adapters/njtech/index.ts"),
);
