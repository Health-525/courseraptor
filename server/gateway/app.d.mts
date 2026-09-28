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
}): Server;
