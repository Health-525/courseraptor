export interface RegistryUser {
  id: string;
  username: string;
  disabled: boolean;
  createdAt: string;
  turns: { date: string; count: number };
  dailyTurns: number;
}

export interface Registry {
  createUser(options: { username: string; password: string }): Promise<{ id: string; username: string }>;
  findUserByName(username: string): Promise<RegistryUser | null>;
  findUserById(id: string): Promise<RegistryUser | null>;
  authenticate(
    username: string,
    password: string,
  ): Promise<{ user: RegistryUser; disabled: false } | { user: null; disabled: true } | null>;
  setPassword(id: string, newPassword: string): Promise<void>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
  setDailyTurns(id: string, turns: number): Promise<void>;
  getSiteSettings(): Promise<{ deepseekKey: string }>;
  setSiteSettings(patch: { deepseekKey?: string }): Promise<void>;
  addTurns(id: string, count?: number): Promise<number>;
  turnsToday(id: string): Promise<number>;
  listUsers(): Promise<RegistryUser[]>;
  createInvites(options?: {
    count?: number;
    note?: string;
    expiresDays?: number;
  }): Promise<Array<{ code: string; note: string; maxUses: number; usedBy: string[]; expiresAt: string }>>;
  consumeInvite(code: string): Promise<boolean>;
  markInviteUsed(code: string, username: string): Promise<void>;
  listInvites(): Promise<Array<{ code: string; note: string; maxUses: number; usedBy: string[]; expiresAt: string }>>;
}

export function createRegistry(options: { stateDir: string }): Registry;
