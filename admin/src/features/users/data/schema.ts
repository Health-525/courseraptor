import { z } from 'zod'

/**
 * 同学账号（网关 /admin/api/users 的形状，bootstrap 带出）。
 * status 为前端派生：已停用 > 在线 > 正常，供筛选与徽章用。
 */
export type UserStatus = 'active' | 'disabled' | 'online'

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  disabled: z.boolean(),
  createdAt: z.coerce.string(),
  turns: z.object({ date: z.string(), count: z.number() }),
  dailyTurns: z.number(),
  ownTurns: z.object({ date: z.string(), count: z.number() }),
  /** '' = 跟随（有自己 Key 即用）；'site' = 钉在站点免费额度 */
  dsMode: z.union([z.literal(''), z.literal('site')]),
  online: z.boolean().optional(),
  startedAt: z.string().optional(),
  lastRequestAt: z.string().optional(),
  restarts: z.number().optional(),
})
export type User = z.infer<typeof userSchema>

export const userListSchema = z.array(userSchema)
