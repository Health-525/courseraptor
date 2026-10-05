export interface Spawner {
  acquire(userId: string): Promise<number>;
  noteActivity(userId: string): void;
  kick(userId: string): void;
  stopAll(): Promise<void>;
  runningCount(): number;
  isRunning(userId: string): boolean;
  listRunning(): Array<{
    userId: string;
    port: number | null;
    startedAt: number;
    lastRequestAt: number;
    restarts: number;
  }>;
  startReaper(): () => void;
  /** Token 用量上报令牌解析：无效令牌返回 null（未装配该能力的 spawner 无此方法） */
  resolveReportToken?(token: string): string | null;
}

export function createSpawner(options: {
  projectRoot: string;
  usersDir: string;
  deepseekKey?: string;
  getDeepseekKey?: (() => Promise<string>) | null;
  getForceSiteKey?: ((userId: string) => Promise<boolean>) | null;
  getProviderId?: ((userId: string) => Promise<string>) | null;
  getProviderSiteKey?: ((providerId: string) => Promise<string>) | null;
  getSiteDefault?: (() => Promise<{ provider?: string; model?: string }>) | null;
  /** Token 用量上报端点（注入子实例 env；空串=不上报） */
  reportBaseUrl?: string;
  maxConcurrent?: number;
  idleMinutes?: number;
  reapIntervalMs?: number;
  nodeExec?: string;
}): Spawner;

export function buildInstanceEnv(
  sourceEnv: Record<string, string | undefined>,
  options: {
    port: number;
    dataDir: string;
    credFile: string;
    siteKey?: string;
    fallbackKey?: string;
    forceSite?: boolean;
    providerId?: string;
    providerSiteKey?: string;
    /** 站点默认型号（site.json）：只兜底从没选过型号的同学 */
    siteModel?: string;
    /** Token 用量上报端点与 per-instance 令牌（两者成对注入） */
    reportUrl?: string;
    reportToken?: string;
  },
): Record<string, string>;
