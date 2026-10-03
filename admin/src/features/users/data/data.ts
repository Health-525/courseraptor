import { type UserStatus } from './schema'

export const callTypes = new Map<UserStatus, string>([
  ['active', 'bg-teal-100/30 text-teal-900 dark:text-teal-200 border-teal-200'],
  ['online', 'bg-sky-200/40 text-sky-900 dark:text-sky-100 border-sky-300'],
  [
    'disabled',
    'bg-destructive/10 dark:bg-destructive/50 text-destructive dark:text-primary border-destructive/10',
  ],
])

export const statusOptions = [
  { label: '正常', value: 'active' },
  { label: '在线', value: 'online' },
  { label: '已停用', value: 'disabled' },
] as const

export const keySourceOptions = [
  { label: '站点额度', value: 'site' },
  { label: '自有优先', value: 'own' },
] as const
