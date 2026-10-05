/** 网关 Token 用量账本（token-usage.json：天 → 用户 → 模型 → 输入/输出） */

export interface TokenUsageRecordInput {
  userId: string;
  model: string;
  in: number;
  out: number;
}

export interface TokenUsageDayPoint {
  date: string;
  in: number;
  out: number;
  total: number;
}

export interface TokenUsageQueryResult {
  range: string;
  from: string;
  to: string;
  total: { in: number; out: number; total: number };
  days: TokenUsageDayPoint[];
  byUser: Array<{ id: string; in: number; out: number; total: number }>;
  byModel: Array<{ model: string; in: number; out: number; total: number }>;
  facets: { users: string[]; models: string[] };
}

export interface TokenUsageStore {
  /** 载荷合法即记录并返回 true；脏载荷返回 false 不落盘 */
  record(input: TokenUsageRecordInput): Promise<boolean>;
  query(input?: { range?: string; user?: string; model?: string }): Promise<TokenUsageQueryResult>;
}

export function createTokenUsageStore(options: { stateDir: string }): TokenUsageStore;
