import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MoreHorizontal, Search, UserPlus } from 'lucide-react'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { userAction, userCreate, type AdminUser } from '@/lib/api'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type StatusFilter = 'all' | 'active' | 'disabled' | 'online'

/** 用户面板：搜索 / 状态筛选 / 增建号 / 限额 / 停启用 / 回收 / 删除（与旧管理台对齐） */
export function UsersPage() {
  const { data, isLoading } = useBootstrap()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  const users = data?.users ?? []
  const siteDefaultTurns = data?.site.defaultDailyTurns ?? 0

  // 来源列：用 username 反查邀请码（usedBy 存的是用户名，见 app.mjs 的
  // markInviteUsed(form.invite, user.username)；pending-* 占位跳过）
  const inviteByUser = useMemo(() => {
    const map = new Map<string, { code: string; note: string }>()
    for (const inv of data?.invites ?? []) {
      for (const name of inv.usedBy ?? []) {
        if (!name.startsWith('pending-')) map.set(name, { code: inv.code, note: inv.note })
      }
    }
    return map
  }, [data?.invites])

  const today = new Date().toISOString().slice(0, 10)
  const filtered = users.filter((u) => {
    if (search && !u.username.toLowerCase().includes(search.toLowerCase())) return false
    if (status === 'active' && u.disabled) return false
    if (status === 'disabled' && !u.disabled) return false
    if (status === 'online' && !u.online) return false
    return true
  })

  return (
    <>
      <AdminHeader title='用户' pretitle='ADMIN · 管理' />
      <Main>
        <Card>
          <CardHeader className='gap-4 sm:flex-row sm:items-center sm:justify-between'>
            <div className='space-y-1.5'>
              <CardTitle>同学账号</CardTitle>
              <CardDescription>
                共 {users.length} 个账号 · {users.filter((u) => u.online).length} 个在线
              </CardDescription>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <div className='relative'>
                <Search className='text-muted-foreground absolute start-2.5 top-2.5 size-4' />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder='搜索用户名…'
                  className='h-9 w-44 ps-8'
                />
              </div>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as StatusFilter)}
              >
                <SelectTrigger className='h-9 w-28'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部状态</SelectItem>
                  <SelectItem value='active'>正常</SelectItem>
                  <SelectItem value='disabled'>已停用</SelectItem>
                  <SelectItem value='online'>在线</SelectItem>
                </SelectContent>
              </Select>
              <UserCreateDialog>
                <Button size='sm'>
                  <UserPlus />
                  新增用户
                </Button>
              </UserCreateDialog>
            </div>
          </CardHeader>
          <CardContent className='px-0'>
            {isLoading && (
              <div className='flex flex-col gap-2 px-6 pb-4'>
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className='h-10 w-full' />
                ))}
              </div>
            )}
            {data && (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户名</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>Key 来源</TableHead>
                      <TableHead>在线</TableHead>
                      <TableHead>来源</TableHead>
                      <TableHead>注册于</TableHead>
                      <TableHead>今日轮数</TableHead>
                      <TableHead className='w-10' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={8}
                          className='text-muted-foreground py-8 text-center'
                        >
                          {users.length === 0 ? '还没有同学注册' : '没有匹配的用户'}
                        </TableCell>
                      </TableRow>
                    )}
                    {filtered.map((u) => (
                      <UserRow
                        key={u.id}
                        user={u}
                        invite={inviteByUser.get(u.username)}
                        siteDefaultTurns={siteDefaultTurns}
                        turnsToday={u.turns.date === today ? u.turns.count : 0}
                        ownTurnsToday={u.ownTurns.date === today ? u.ownTurns.count : 0}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

function UserRow({
  user,
  invite,
  siteDefaultTurns,
  turnsToday,
  ownTurnsToday,
}: {
  user: AdminUser
  invite: { code: string; note: string } | undefined
  siteDefaultTurns: number
  turnsToday: number
  ownTurnsToday: number
}) {
  const invalidate = useInvalidateBootstrap()
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<
    'disable' | 'enable' | 'kick' | 'delete' | null
  >(null)

  const act = useMutation({
    mutationFn: async () => {
      if (!confirmAction) throw new Error('no action')
      if (confirmAction === 'delete') return userAction('delete', user.id)
      return userAction(confirmAction, user.id)
    },
    onSuccess: () => {
      const labels = {
        disable: `已停用 ${user.username}`,
        enable: `已启用 ${user.username}`,
        kick: `已回收 ${user.username} 的实例`,
        delete: `已删除 ${user.username}（含数据目录）`,
      } as const
      toast.success(labels[confirmAction ?? 'enable'])
      setConfirmAction(null)
      void invalidate()
    },
  })

  const effectiveLimit = user.dailyTurns > 0 ? user.dailyTurns : siteDefaultTurns

  const confirmCopy = {
    disable: {
      title: '停用账号',
      desc: `停用后 ${user.username} 将立即无法登录（在线实例也会被拒绝）。确认停用？`,
      confirm: '停用',
    },
    enable: {
      title: '启用账号',
      desc: `恢复 ${user.username} 的登录权限。`,
      confirm: '启用',
    },
    kick: {
      title: '回收实例',
      desc: `立即结束 ${user.username} 的专属实例进程，同学正在用的对话会中断（下次登录自动拉起）。`,
      confirm: '回收',
    },
    delete: {
      title: '删除用户',
      desc: `账号、登录凭证与其专属数据目录将一并删除，不可恢复。确认删除 ${user.username}？`,
      confirm: '删除',
    },
  } as const

  return (
    <TableRow>
      <TableCell className='font-mono font-semibold'>{user.username}</TableCell>
      <TableCell>
        {user.disabled ? (
          <Badge variant='destructive'>已停用</Badge>
        ) : (
          <Badge variant='secondary'>正常</Badge>
        )}
      </TableCell>
      <TableCell>
        {user.dsMode === 'site' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant='outline'>站点额度</Badge>
            </TooltipTrigger>
            <TooltipContent>同学选择了「站点免费额度」模式</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant='outline'>自有优先</Badge>
            </TooltipTrigger>
            <TooltipContent>
              有自己的 Key 用自己的（不占站点额度），没有则用站点 Key
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='inline-flex items-center'>
              <span
                className={`inline-block size-2 rounded-full ${user.online ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {user.online
              ? `启动 ${fmtDateTime(user.startedAt)} · 最近活跃 ${fmtRelative(user.lastRequestAt)}${user.restarts ? ` · 曾重启 ${user.restarts} 次` : ''}`
              : '离线'}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className='text-muted-foreground max-w-40 truncate text-xs'>
        {invite ? invite.note || invite.code : '—'}
      </TableCell>
      <TableCell className='text-muted-foreground text-xs'>
        {fmtDateTime(user.createdAt)}
      </TableCell>
      <TableCell>
        <span className='tabular-nums'>
          {turnsToday} / {effectiveLimit}
        </span>
        {user.dailyTurns > 0 && (
          <Badge variant='outline' className='ms-1 text-[10px]'>
            个人
          </Badge>
        )}
        {ownTurnsToday > 0 && (
          <Badge variant='secondary' className='ms-1 text-[10px]'>
            +自{ownTurnsToday}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant='ghost' size='icon' className='size-8'>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuLabel>{user.username}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setQuotaOpen(true)}>
              设限额
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDetailOpen(true)}>
              详情
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {user.disabled ? (
              <DropdownMenuItem onClick={() => setConfirmAction('enable')}>
                启用
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => setConfirmAction('disable')}>
                停用
              </DropdownMenuItem>
            )}
            {user.online && (
              <DropdownMenuItem onClick={() => setConfirmAction('kick')}>
                回收实例
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant='destructive'
              onClick={() => setConfirmAction('delete')}
            >
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>

      <QuotaDialog
        open={quotaOpen}
        onOpenChange={setQuotaOpen}
        user={user}
        siteDefaultTurns={siteDefaultTurns}
      />
      <DetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        user={user}
        invite={invite}
        siteDefaultTurns={siteDefaultTurns}
        turnsToday={turnsToday}
        ownTurnsToday={ownTurnsToday}
      />
      <ConfirmActionDialog
        open={confirmAction !== null}
        onOpenChange={(v) => !v && setConfirmAction(null)}
        copy={confirmAction ? confirmCopy[confirmAction] : undefined}
        loading={act.isPending}
        onConfirm={() => act.mutate()}
      />
    </TableRow>
  )
}

/** 新增用户：不走邀请码直接建号 */
function UserCreateDialog({
  children,
}: {
  children: React.ReactNode
}) {
  const invalidate = useInvalidateBootstrap()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const create = useMutation({
    mutationFn: () => userCreate(username.trim(), password),
    onSuccess: (res) => {
      toast.success(`已创建 ${res.user.username}，账号建好即可登录`)
      setOpen(false)
      setUsername('')
      setPassword('')
      setError('')
      void invalidate()
    },
    onError: (e) => {
      setError((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '创建失败')
    },
  })

  const valid =
    /^[A-Za-z0-9_-]{2,32}$/.test(username.trim()) && password.length >= 8

  return (
    <>
      <span onClick={() => setOpen(true)}>{children}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='sm:max-w-sm'>
          <DialogHeader>
            <DialogTitle>新增用户</DialogTitle>
            <DialogDescription>
              不走邀请码直接建号；账号建好即可登录，同学登录后可自行改密码。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3'>
            {error && <p className='text-destructive text-sm'>{error}</p>}
            <div className='grid gap-1.5'>
              <Label htmlFor='new-username'>用户名</Label>
              <Input
                id='new-username'
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder='字母 / 数字 / _ / -，2-32 位'
                autoComplete='off'
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='new-password'>初始密码（至少 8 位）</Label>
              <Input
                id='new-password'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder='同学登录后可自行修改'
                autoComplete='off'
                className='font-mono'
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function QuotaDialog({
  open,
  onOpenChange,
  user,
  siteDefaultTurns,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  user: AdminUser
  siteDefaultTurns: number
}) {
  const invalidate = useInvalidateBootstrap()
  const [value, setValue] = useState('')

  // 每次打开重置为当前值
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) setValue(String(user.dailyTurns))
  }

  const save = useMutation({
    mutationFn: () => userAction('quota', user.id, { turns: Number(value) }),
    onSuccess: () => {
      toast.success(`${user.username} 每日限额已更新`)
      onOpenChange(false)
      void invalidate()
    },
  })

  const num = Number(value)
  const valid = Number.isInteger(num) && num >= 0 && num <= 100000

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>设置每日限额 · {user.username}</DialogTitle>
          <DialogDescription>
            站点默认 {siteDefaultTurns} 轮/人/日；填 0 表示跟随站点默认。只限制用站点
            Key 的轮数，同学用自己的 Key 不受限。
          </DialogDescription>
        </DialogHeader>
        <Input
          type='number'
          min={0}
          max={100000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder='0 = 用站点默认'
        />
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailDialog({
  open,
  onOpenChange,
  user,
  invite,
  siteDefaultTurns,
  turnsToday,
  ownTurnsToday,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  user: AdminUser
  invite: { code: string; note: string } | undefined
  siteDefaultTurns: number
  turnsToday: number
  ownTurnsToday: number
}) {
  const rows: [string, string][] = [
    ['状态', user.disabled ? '已停用' : '正常'],
    ['Key 模式', user.dsMode === 'site' ? '站点免费额度' : '自有优先'],
    ['今日站点轮数', String(turnsToday)],
    ['今日自有轮数', String(ownTurnsToday)],
    ['每日限额', user.dailyTurns > 0 ? `${user.dailyTurns}（个人覆盖）` : `${siteDefaultTurns}（站点默认）`],
    ['来源邀请码', invite ? invite.code : '—'],
    ['注册于', fmtDateTime(user.createdAt)],
    ['专属实例', user.online
      ? `在线 · 启动 ${fmtDateTime(user.startedAt)} · 最近活跃 ${fmtRelative(user.lastRequestAt)}${user.restarts ? ` · 重启 ${user.restarts} 次` : ''}`
      : '离线'],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='font-mono'>{user.username}</DialogTitle>
          <DialogDescription>账号详情</DialogDescription>
        </DialogHeader>
        <div className='grid gap-2 text-sm'>
          {rows.map(([k, v]) => (
            <div key={k} className='flex gap-4'>
              <span className='text-muted-foreground w-24 shrink-0'>{k}</span>
              <span className='min-w-0 break-all'>{v}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmActionDialog({
  open,
  onOpenChange,
  copy,
  loading,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  copy: { title: string; desc: string; confirm: string } | undefined
  loading: boolean
  onConfirm: () => void
}) {
  if (!copy) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.desc}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant={copy.confirm === '启用' ? 'default' : 'destructive'}
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? '处理中…' : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
