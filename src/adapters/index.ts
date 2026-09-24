/**
 * 学校适配器装配点
 *
 * 入口文件（channels/cli、channels/qq、需要 school() 的测试）在顶部
 * `import "../../adapters"`（按相对深度调整）即可完成默认学校注册；
 * RAPTOR_SCHOOL 环境变量可切换实现。新增一所学校：在 adapters/ 下建
 * 目录实现 SchoolAdapter，然后加进 IMPLEMENTATIONS。
 */

import { registerSchool } from "../core/school";
import { njtechSchool } from "./njtech";

const IMPLEMENTATIONS = {
  njtech: njtechSchool,
};

export function installDefaultSchool(): void {
  const id = process.env.RAPTOR_SCHOOL ?? "njtech";
  const adapter = IMPLEMENTATIONS[id as keyof typeof IMPLEMENTATIONS];
  if (!adapter) {
    throw new Error(
      `未知学校适配器「${id}」：可用 ${Object.keys(IMPLEMENTATIONS).join("、")}（RAPTOR_SCHOOL 环境变量指定）`,
    );
  }
  registerSchool(adapter);
}

installDefaultSchool();
