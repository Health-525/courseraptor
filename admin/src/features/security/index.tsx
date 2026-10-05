import { useState } from 'react'
import { AxiosError } from 'axios'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Copy, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { totpDisable, totpEnable, totpRecovery, totpSetup } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtDate } from '@/lib/format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'

/**
 * 安全设置：TOTP 两步验证（绑定扫码 → 验证启用 → 恢复码仅此一次展示）。
 * 关闭/重生成恢复码要求再验一次动态码（防会话劫持降级）；
 * 启用/关闭会使所有管理会话立即失效（sessionEpoch），需重新登录。
 */
export function SecurityPage() {
  const { data, isLoading } = useBootstrap()
  const security = data?.security

  return (
    <>
      <AdminHeader title='安全设置' pretitle='ADMIN · 配置' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>两步验证（TOTP）</CardTitle>
            <CardDescription>
              登录需密码 + 手机验证器 6 位动态码
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className='h-32 w-full' />}
            {security &&
              (security.mfaEnabled ? <EnabledView /> : <SetupView />)}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

/** ── 未启用：绑定流程 ──────────────────────────────────────── */
function SetupView() {
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(
    null
  )
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)

  const start = useMutation({
    mutationFn: totpSetup,
    onSuccess: (res) => {
      setSetup({ secret: res.secret, qrSvg: res.qrSvg })
      setCode('')
      setError('')
    },
  })

  const enable = useMutation({
    mutationFn: () => totpEnable(code.trim()),
    onSuccess: (res) => {
      setRecovery(res.recoveryCodes)
      setSetup(null)
    },
    onError: (e) => {
      setError(
        e instanceof AxiosError
          ? ((e.response?.data as { error?: string })?.error ?? '验证失败')
          : '验证失败'
      )
    },
  })

  if (recovery) return <RecoveryCodes codes={recovery} needRelogin />

  if (!setup) {
    return (
      <div className='space-y-3'>
        <p className='text-sm text-muted-foreground'>
          启用后登录管理台需要「管理密码 + 手机验证器动态码」，并附 10
          枚一次性恢复码。手机与恢复码全丢时，需要 SSH 上服务器执行
          <code className='mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
            admin.mjs totp off
          </code>
          才能恢复仅密码登录。
        </p>
        <Button disabled={start.isPending} onClick={() => start.mutate()}>
          <ShieldCheck />
          启用两步验证
        </Button>
      </div>
    )
  }

  // base32 密钥每 4 位分组，方便手工输入
  const grouped = setup.secret.replace(/(.{4})/g, '$1 ').trim()

  return (
    <div className='space-y-4'>
      <ol className='list-decimal space-y-1 ps-5 text-sm text-muted-foreground'>
        <li>
          用手机验证器（Google / Microsoft Authenticator 等）扫下面的二维码
        </li>
        <li>输入验证器当前显示的 6 位数字完成绑定</li>
      </ol>
      <div className='flex justify-center rounded-lg border bg-white p-4 dark:border-border [&>svg]:size-52'>
        <div dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
      </div>
      <div className='space-y-1.5'>
        <p className='text-xs text-muted-foreground'>
          扫不了码？在验证器里选择「输入密钥」，粘贴：
        </p>
        <div className='flex gap-2'>
          <code className='min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-sm'>
            {grouped}
          </code>
          <Button
            variant='outline'
            size='sm'
            className='shrink-0'
            onClick={() => void copyText(setup.secret)}
          >
            <Copy />
            复制
          </Button>
        </div>
      </div>
      <div className='flex max-w-xs gap-2'>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder='6 位数字'
          inputMode='numeric'
          className='font-mono tracking-widest'
        />
        <Button
          className='shrink-0'
          disabled={code.trim().length < 6 || enable.isPending}
          onClick={() => enable.mutate()}
        >
          验证并启用
        </Button>
      </div>
      {error && <p className='text-sm text-destructive'>{error}</p>}
    </div>
  )
}

/** ── 已启用：状态 + 高危操作（再验动态码）─────────────────── */
function EnabledView() {
  const { data } = useBootstrap()
  const security = data!.security
  const invalidate = useInvalidateBootstrap()
  const navigate = useNavigate()
  const [action, setAction] = useState<'disable' | 'recovery' | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)

  const run = useMutation({
    mutationFn: async (): Promise<string[]> => {
      if (action === 'disable') {
        await totpDisable(code.trim())
        return []
      }
      const res = await totpRecovery(code.trim())
      return res.recoveryCodes
    },
    onSuccess: (res) => {
      if (action === 'disable') {
        toast.success(
          '两步验证已关闭，恢复仅密码登录（所有会话已注销，请重新登录）'
        )
        setAction(null)
        navigate({ to: '/sign-in', replace: true })
        return
      }
      setRecovery(res)
      setAction(null)
      void invalidate()
    },
    onError: (e) => {
      setError(
        e instanceof AxiosError
          ? ((e.response?.data as { error?: string })?.error ?? '验证失败')
          : '验证失败'
      )
    },
  })

  if (recovery)
    return <RecoveryCodes codes={recovery} onClose={() => setRecovery(null)} />

  return (
    <div className='space-y-4'>
      <Alert>
        <ShieldCheck />
        <AlertTitle>两步验证已启用</AlertTitle>
        <AlertDescription>
          启用于 {fmtDate(security.enabledAt)} · 恢复码剩余{' '}
          {security.recoveryLeft} 枚
        </AlertDescription>
      </Alert>
      <div className='max-w-xs space-y-1.5'>
        <Label htmlFor='totp-code'>当前动态码</Label>
        <div className='flex gap-2'>
          <Input
            id='totp-code'
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setError('')
            }}
            placeholder='验证器 6 位数字（或恢复码）'
            inputMode='numeric'
            className='font-mono tracking-widest'
          />
        </div>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          disabled={code.trim().length < 6 || run.isPending}
          onClick={() => {
            setAction('recovery')
            setError('')
            run.mutate()
          }}
        >
          重新生成恢复码
        </Button>
        <Button
          variant='destructive'
          disabled={code.trim().length < 6 || run.isPending}
          onClick={() => {
            setAction('disable')
            setError('')
            run.mutate()
          }}
        >
          关闭两步验证
        </Button>
      </div>
      {error && <p className='text-sm text-destructive'>{error}</p>}
      <p className='text-xs text-muted-foreground'>
        高危操作需再验一次动态码；关闭后所有管理会话立即注销。SSH
        兜底：admin.mjs totp off。
      </p>
    </div>
  )
}

/** ── 恢复码展示（启用成功 / 重生成后，仅此一次）──────────── */
function RecoveryCodes({
  codes,
  needRelogin = false,
  onClose,
}: {
  codes: string[]
  needRelogin?: boolean
  onClose?: () => void
}) {
  const navigate = useNavigate()
  return (
    <Dialog open>
      <DialogContent
        className='sm:max-w-md'
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>恢复码（仅此一次展示）</DialogTitle>
          <DialogDescription>
            {needRelogin
              ? '两步验证已启用。请把这 10 枚恢复码保存到安全的地方——手机丢了用它们登录（每枚一次性）。所有管理会话已注销，稍后需重新登录。'
              : '旧的恢复码已全部作废。请保存这 10 枚新恢复码（每枚一次性）。'}
          </DialogDescription>
        </DialogHeader>
        <div className='grid grid-cols-2 gap-2 font-mono text-sm'>
          {codes.map((c) => (
            <code
              key={c}
              className='rounded bg-muted px-2 py-1.5 tracking-wider'
            >
              {c}
            </code>
          ))}
        </div>
        <DialogFooter className='gap-2 sm:gap-0'>
          <Button
            variant='outline'
            onClick={() => void copyText(codes.join('\n'))}
          >
            <Copy />
            复制全部
          </Button>
          {needRelogin ? (
            <Button onClick={() => navigate({ to: '/sign-in', replace: true })}>
              已保存，去重新登录
            </Button>
          ) : (
            <Button onClick={onClose}>我已保存</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
