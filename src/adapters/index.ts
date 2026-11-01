/**
 * 学校适配器装配点
 *
 * 入口文件（channels/cli、channels/qq、需要 school() 的测试）在顶部
 * `import "../../adapters"`（按相对深度调整）即可完成学校注册。
 *
 * 内置只有 custom（「不接入任何学校」的手动课表兜底）：不指向任何真实
 * 学校、零教务联网，课表靠手动导入。运行期切换走 core/school 的 selectSchool。
 *
 * 默认学校取设置里保存的 schoolId（加密凭证，每人一份）；已保存的学校若
 * 不再可用（如历史版本接入过的学校已移除），启动时如实提示并回落 custom，
 * 不挡启动。
 */

import { loadCredentialsStore } from "../core/credentials";
import { registerSchoolOption, selectSchool } from "../core/school";
import { customSchool } from "./custom";

// 登记顺序即设置页的学校列表顺序：custom（手动课表）垫底。
registerSchoolOption(customSchool);

export function installDefaultSchool(): void {
  const saved = loadCredentialsStore()?.schoolId;
  if (!saved || !selectSchool(saved)) {
    if (saved) {
      console.warn(
        `已保存的学校「${saved}」不再可用，已回落到手动课表（custom）；可在设置 → 学校里重新选择。`,
      );
    }
    selectSchool("custom");
  }
}

installDefaultSchool();
