/**
 * 学校适配器装配点
 *
 * 入口文件（channels/cli、channels/qq、需要 school() 的测试）在顶部
 * `import "../../adapters"`（按相对深度调整）即可完成学校注册；
 * RAPTOR_SCHOOL 环境变量可强制指定实现。新增一所学校：在 adapters/ 下建
 * 目录实现 SchoolAdapter，然后加进下面的 OPTIONS 登记。
 *
 * 默认学校的取舍顺序：RAPTOR_SCHOOL 环境变量（开发者逃生舱）> 设置里
 * 保存的 schoolId（加密凭证，托管版每人一份、互不影响）> "custom"。
 *
 * 默认 custom＝「不接入任何学校」：不指向任何真实学校、零教务联网，
 * 课表靠手动导入。接入某所学校是用户在网页设置页「学校」栏里的
 * 显式选择，绝不默认接上。运行期切换走 core/school 的 selectSchool。
 */

import { loadCredentialsStore } from "../core/credentials";
import { listSchoolOptions, registerSchoolOption, selectSchool } from "../core/school";
import { customSchool } from "./custom";
import { njtechSchool } from "./njtech";

/** 登记顺序即设置页的学校列表顺序：真实学校在前，「其他学校」垫底 */
registerSchoolOption(njtechSchool);
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
