/** 匿名设备记录（local-usage.json，键为随机设备号，无个人身份信息） */
export interface LocalUsageClient {
  /** 随机设备号（展示态只保留前 8 位） */
  id: string;
  firstSeen: string;
  lastSeen: string;
  pings: number;
  version: string;
  platform: string;
  channel: string;
}

export interface LocalUsageStats {
  total: number;
  activeToday: number;
  active7d: number;
  active30d: number;
  versions: Array<{ name: string; count: number }>;
  platforms: Array<{ name: string; count: number }>;
  lastPingAt: string;
  recent: LocalUsageClient[];
}

export interface LocalUsageStore {
  /** 形状合法即记录并返回 true；脏载荷返回 false 不落盘 */
  record(input: {
    id: string;
    version: string;
    channel: string;
    platform: string;
  }): Promise<boolean>;
  stats(): Promise<LocalUsageStats>;
}

export function createLocalUsageStore(options: { stateDir: string }): LocalUsageStore;
