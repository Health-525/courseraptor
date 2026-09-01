/**
 * 项目根目录解析（独立模块避免 config <-> credentials 循环依赖）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
