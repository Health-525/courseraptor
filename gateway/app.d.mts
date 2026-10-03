import type { Server } from "node:http";

export function createGatewayServer(options: {
  registry: import("./registry.mjs").Registry;
  spawner: import("./spawner.mjs").Spawner;
  secret: string;
  dailyTurns?: number;
  projectRoot?: string;
  adminPassword?: string;
  maxConcurrent?: number;
  updateServerUrl?: string;
  updateAdminToken?: string;
  usersDir?: string;
  /** 管理台展示用：部署的代码版本（package.json version） */
  appVersion?: string;
  /** 管理台展示用：env 是否兜底配了站点 DeepSeek Key */
  envDeepseekKeySet?: boolean;
  /** 本地版匿名使用统计（缺省时 POST /api/local-usage 回 501） */
  localUsage?: import("./local-usage.mjs").LocalUsageStore | null;
}): Server;
