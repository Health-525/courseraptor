/**
 * 学校适配器装配点
 *
 * 入口文件（channels/cli、channels/qq、需要 school() 的测试）在顶部
 * `import "../../adapters"`（按相对深度调整）即可完成学校注册。
 *
 * 2026-10 起仓库不再内置任何学校的在线教务适配器（合规取舍：程序不保存
 * 教务密码、不代登录、不请求教务系统），唯一注册的是手动课表模式
 * （custom）：课表等数据全部由用户自行导入本地缓存。
 * SchoolAdapter 端口保持开放，自定义实现的学校仍可按端口接入。
 */

import { registerSchool } from "../core/school";
import { customSchool } from "./custom";

registerSchool(customSchool);
