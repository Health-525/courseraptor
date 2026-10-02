export interface RegistryUser {
  id: string;
  username: string;
  disabled: boolean;
  createdAt: string;
  turns: { date: string; count: number };
  ownTurns: { date: string; count: number };
  dailyTurns: number;
  dsMode: string;
  /** 当前选的模型供应商 id（内置厂商；缺省 deepseek）。空串按 deepseek 处理 */
  providerId?: string;
}

/** 管理台两步验证落盘形态（admin-totp.json，不存在即未启用） */
export interface AdminTotpDoc {
  secret: string;
  enabledAt: string;
  recovery: string[];
  lastUsedCounter?: number;
  sessionEpoch?: number;
}

export interface Registry {
  createUser(options: {
    username: string;
    password: string;
  }): Promise<{ id: string; username: string }>;
  findUserByName(username: string): Promise<RegistryUser | null>;
  findUserById(id: string): Promise<RegistryUser | null>;
  authenticate(
    username: string,
    password: string,
  ): Promise<{ user: RegistryUser; disabled: false } | { user: null; disabled: true } | null>;
  setPassword(id: string, newPassword: string): Promise<void>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
  setDailyTurns(id: string, turns: number): Promise<void>;
  ownTurnsToday(id: string): Promise<number>;
  setDsMode(id: string, mode: string): Promise<void>;
  /** 模型供应商选择（合法形状的内置厂商 id；custom 一律拒绝） */
  setProviderId(id: string, providerId: string): Promise<void>;
  getSiteSettings(): Promise<{ deepseekKey: string }>;
  setSiteSettings(patch: { deepseekKey?: string }): Promise<void>;
  getAdminTotp(): Promise<AdminTotpDoc | null>;
  setAdminTotp(doc: AdminTotpDoc): Promise<void>;
  clearAdminTotp(): Promise<void>;
  createResetRequest(userId: string, username: string): Promise<{ id: string }>;
  listResetRequests(): Promise<{
    pending: Array<{
      id: string;
      userId: string;
      username: string;
      requestedAt: string;
      status: string;
    }>;
    codes: Array<{
      code: string;
      userId: string;
      username: string;
      createdAt: string;
      expiresAt: string;
    }>;
  }>;
  approveResetRequest(id: string): Promise<{ code: string; username: string; expiresAt: string }>;
  rejectResetRequest(id: string): Promise<void>;
  redeemResetCode(username: string, code: string): Promise<string | null>;
  addTurns(id: string, count?: number, ledger?: "site" | "own"): Promise<number>;
  turnsToday(id: string): Promise<number>;
  listUsers(): Promise<RegistryUser[]>;
  createInvites(options?: {
    count?: number;
    note?: string;
    expiresDays?: number;
  }): Promise<
    Array<{ code: string; note: string; maxUses: number; usedBy: string[]; expiresAt: string }>
  >;
  consumeInvite(code: string): Promise<boolean>;
  /** 注册中途失败时释放 pending 占位，码退回可再次消费 */
  releaseInvite(code: string): Promise<void>;
  markInviteUsed(code: string, username: string): Promise<void>;
  listInvites(): Promise<
    Array<{ code: string; note: string; maxUses: number; usedBy: string[]; expiresAt: string }>
  >;
}

export function createRegistry(options: { stateDir: string }): Registry;
