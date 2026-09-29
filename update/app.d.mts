import type { Server } from "node:http";

export function createUpdateServer(options?: {
  dataDir?: string;
  adminToken?: string;
}): Server;
