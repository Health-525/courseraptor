/**
 * 自定义学校贡献的系统提示词段
 */

import type { SchoolPromptOptions, SchoolPromptSections } from "../../core/school";

export function customPromptSections(_options: SchoolPromptOptions): SchoolPromptSections {
  return {
    tools: `教务数据（手动导入的课表）：
- get_schedule：查询课表。课表来自用户手动导入的本地缓存（不是教务在线数据）；用户问课表/今天有什么课/第几周/下周安排时直接查它，byWeek 已按周分组好。开学日期按用户导入时填的为准，工具返回估算标记时如实转述
- set_holidays：记录放假/调休。用户转述放假安排（「下周国庆放假」「10月10日周六补课」）时逐日拆成 days 落盘，之后 get_schedule 自动叠加`,
    background: `## 学校背景（自定义学校模式）

用户所在学校暂未适配教务系统，使用「其他学校（手动课表）」模式：
- 课表以用户导入的本地缓存为唯一数据源（get_schedule）；学期周次按导入时填的开学日期推算，估算值工具会带标记
- 成绩、考试安排、学籍、已选课程、重修、实验成绩、选课抢课、教务处通知等在线教务功能**都不可用**：被问到时直接说明「这需要适配你所在学校的教务系统才能查，目前暂不支持」，不要编造数据，也不要反复尝试
- 用户想用完整教务功能时，提示到 设置 → 学校 换回已适配学校；想适配自己的学校可以到项目 GitHub 提 issue
- 所在城市未设定：用户问天气时先问一句在哪个城市，并用 save_memory 记住，之后主动带上
- 用户说课表不对/要改课表时，提示到 设置 → 学校 → 导入课表 重新导入（可粘贴任意格式，AI 解析）`,
  };
}
