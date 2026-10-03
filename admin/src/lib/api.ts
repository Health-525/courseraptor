/**
 * 管理台 API 客户端：全部走网关 /admin/api/*（会话 Cookie 鉴权）。
 * bootstrap 一次往返带回全部面板数据（跨公网 RTT 大，逐页请求是卡顿主因）。
 */
import axios from 'axios'

export const api = axios.create({
  baseURL: '/admin/api',
  // 同源 Cookie（raptor_admin），超时给足发版上传以外的所有请求
  timeout: 30_000,
})

// ── 数据形状（与 gateway/admin/ui.mjs 的响应一一对应）────────────

export type Overview = {
  users: number
  online: number
  capacity: number
  invitesLeft: number
  turnsToday: number
  ownTurnsToday: number
  pendingResets: number
  uptimeSec: number
  version: string
}

export type AdminUser = {
  id: string
  username: string
  disabled: boolean
  createdAt: string
  turns: { date: string; count: number }
  dailyTurns: number
  ownTurns: { date: string; count: number }
  /** '' = 跟随（有自己 Key 即用）；'site' = 钉在站点免费额度 */
  dsMode: '' | 'site'
  online?: boolean
  startedAt?: string
  lastRequestAt?: string
  restarts?: number
}

export type Invite = {
  code: string
  note: string
  maxUses: number
  usedBy: string[]
  expiresAt: string
}

export type ResetRequest = {
  id: string
  userId: string
  username: string
  requestedAt: string
  status: string
}

export type ResetCode = {
  code: string
  userId: string
  username: string
  createdAt: string
  expiresAt: string
}

export type Security = {
  mfaEnabled: boolean
  enabledAt: string
  recoveryLeft: number
}

export type SiteProviderInfo = {
  id: string
  label: string
  keySet: boolean
  keyMasked: string
  envFallback: boolean
}

export type SiteInfo = {
  deepseekKeySet: boolean
  deepseekKeyMasked: string
  envDeepseekKeySet: boolean
  defaultDailyTurns: number
  /** 各厂商站点 Key 状态（多厂商）；旧后端缺省为空数组 */
  providers?: SiteProviderInfo[]
}

/** 更新后台的调用包装：连不上/未配置 → {unavailable}，拒绝 → {error} */
export type UpdateCall<T> = {
  unavailable?: boolean
  error?: string
  data?: T
}

export type UpdateOverviewData = {
  current: { version: string; notes: string; publishedAt: string } | null
  stats: {
    versionCount: number
    diskBytes: number
    nodeVersion: string
    uptimeSec: number
    dataDir: string
  }
}

export type UpdateVersion = {
  version: string
  notes: string
  publishedAt: string
  sizeBytes: number
  isCurrent: boolean
  rolledBackAt?: string
}

export type UpdateKeysData = {
  keys: {
    id: string
    name: string
    isEnv: boolean
    createdAt: string
    lastUsedAt: string | null
  }[]
}

export type LogEntry = { at: string; ip: string; text: string }

/** 清空操作日志（清空动作本身会作为新日志的第一笔） */
export async function logClear() {
  const res = await api.post('/log/clear')
  return res.data as { ok: boolean }
}

export type Bootstrap = {
  overview: Overview
  users: AdminUser[]
  invites: Invite[]
  resets: { pending: ResetRequest[]; codes: ResetCode[] }
  security: Security
  site: SiteInfo
  update: {
    overview: UpdateCall<UpdateOverviewData>
    versions: UpdateCall<{ versions: UpdateVersion[] }>
    keys: UpdateCall<UpdateKeysData>
  }
  log: LogEntry[]
}

export type SessionInfo = {
  authed: boolean
  mfaRequired: boolean
  version: string
}

// ── 会话 ────────────────────────────────────────────────────────

export async function getSession() {
  const res = await api.get<SessionInfo>('/session')
  return res.data
}

export async function login(password: string, code: string) {
  const res = await api.post('/login', { password, code })
  return res.data as { ok: boolean }
}

export async function logout() {
  await api.post('/logout')
}

// ── 数据读取 ────────────────────────────────────────────────────

export async function fetchBootstrap() {
  const res = await api.get<Bootstrap>('/bootstrap')
  return res.data
}

// ── 用户 ────────────────────────────────────────────────────────

export async function userCreate(username: string, password: string) {
  const res = await api.post('/user/create', { username, password })
  return res.data as { ok: boolean; user: { id: string; username: string } }
}

export async function userAction(
  action: 'quota' | 'enable' | 'disable' | 'kick' | 'delete',
  user: string,
  extra: Record<string, unknown> = {}
) {
  const res = await api.post(`/user/${action}`, { user, ...extra })
  return res.data as { ok: boolean }
}

// ── 邀请码 ──────────────────────────────────────────────────────

export async function inviteCreate(count: number, note: string, days: number) {
  const res = await api.post('/invite', { count, note, days })
  return res.data as { ok: boolean; created: Invite[] }
}

export async function inviteDelete(code: string) {
  const res = await api.post('/invite/delete', { code })
  return res.data as { ok: boolean }
}

// ── 重置审批 ────────────────────────────────────────────────────

export async function resetApprove(id: string) {
  const res = await api.post('/reset/approve', { id })
  return res.data as {
    ok: boolean
    code: string
    username: string
    expiresAt: string
  }
}

export async function resetReject(id: string) {
  const res = await api.post('/reset/reject', { id })
  return res.data as { ok: boolean }
}

/** 作废一枚未兑换的重置码（发错人 / 码外泄时立即失效，不等 24h） */
export async function resetRevoke(code: string) {
  const res = await api.post('/reset/revoke', { code })
  return res.data as { ok: boolean }
}

// ── 站点设置 ────────────────────────────────────────────────────

export async function siteSaveKey(deepseekKey: string) {
  const res = await api.post('/site', { deepseekKey })
  return res.data as { ok: boolean }
}

/** 按厂商保存/清空站点 Key（key 为空串 = 清除该厂商的面板 Key） */
export async function siteSaveProviderKey(provider: string, key: string) {
  const res = await api.post('/site', { provider, key })
  return res.data as { ok: boolean }
}

// ── 两步验证（TOTP）────────────────────────────────────────────

export async function totpSetup() {
  const res = await api.post('/totp/setup')
  return res.data as { secret: string; uri: string; qrSvg: string }
}

export async function totpEnable(code: string) {
  const res = await api.post('/totp/enable', { code })
  return res.data as { ok: boolean; recoveryCodes: string[] }
}

export async function totpDisable(code: string) {
  const res = await api.post('/totp/disable', { code })
  return res.data as { ok: boolean }
}

export async function totpRecovery(code: string) {
  const res = await api.post('/totp/recovery', { code })
  return res.data as { ok: boolean; recoveryCodes: string[] }
}

// ── 版本发布（代理到更新后台）──────────────────────────────────

export async function updateRollback(version: string) {
  const res = await api.post('/update/rollback', { version })
  return res.data as { ok?: boolean; error?: string; unavailable?: boolean }
}

export async function updateDelete(version: string) {
  const res = await api.post('/update/delete', { version })
  return res.data as { ok?: boolean; error?: string; unavailable?: boolean }
}

/** 上传发版：zip 原样作为请求体流式转发，带进度回调与取消 */
export function updatePublish(
  file: File,
  version: string,
  notes: string,
  opts: {
    onProgress?: (loaded: number, total: number) => void
    signal?: AbortSignal
  } = {}
) {
  return api
    .post('/update/publish', file, {
      timeout: 0,
      headers: {
        'content-type': 'application/zip',
        'x-version': version,
        'x-notes': encodeURIComponent(notes),
      },
      onUploadProgress: (e) =>
        opts.onProgress?.(e.loaded ?? 0, e.total ?? file.size),
      signal: opts.signal,
    })
    .then((res) => res.data as Record<string, unknown> & { error?: string })
}

// ── 更新后台密钥 ────────────────────────────────────────────────

export async function keyCreate(name: string) {
  const res = await api.post('/update/keys', { name })
  return res.data as {
    ok?: boolean
    error?: string
    unavailable?: boolean
    data?: { token: string; key: { id: string; name: string } }
  }
}

export async function keyDelete(id: string) {
  const res = await api.post('/update/keys/delete', { id })
  return res.data as { ok?: boolean; error?: string; unavailable?: boolean }
}
