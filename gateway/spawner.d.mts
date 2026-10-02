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
}

export function createSpawner(options: {
  projectRoot: string;
  usersDir: string;
  deepseekKey?: string;
  getDeepseekKey?: (() => Promise<string>) | null;
  getForceSiteKey?: ((userId: string) => Promise<boolean>) | null;
  getProviderId?: ((userId: string) => Promise<string>) | null;
  getProviderSiteKey?: ((providerId: string) => Promise<string>) | null;
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
  },
): Record<string, string>;
