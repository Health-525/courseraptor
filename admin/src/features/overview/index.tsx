import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Rocket,
  Settings2,
  ShieldCheck,
  Ticket,
  Users,
  Zap,
} from 'lucide-react'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap } from '@/lib/admin-data'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

type Level = 'danger' | 'warning' | 'info'

/** 概览：一条 KPI 数据带 + 待办 + 快捷操作 + 最近操作 */
export function Overview() {
  const { data, isLoading } = useBootstrap()

  const o = data?.overview
  const site = data?.site
  const security = data?.security
  const updateOverview = data?.update?.overview

  const alerts: { level: Level; text: string; to: string; action: string }[] = []
  if (o && o.pendingResets > 0) {
    alerts.push({
      level: 'warning',
      text: `${o.pendingResets} 个密码重置申请待审批`,
      to: '/resets',
      action: '去处理',
    })
  }
  if (site && !site.deepseekKeySet && !site.envDeepseekKeySet) {
    alerts.push({
      level: 'danger',
      text: '站点 DeepSeek Key 未设置（面板与服务器 env 都没有）',
      to: '/site',
      action: '去设置',
    })
  }
  if (updateOverview?.unavailable) {
    alerts.push({
      level: 'info',
      text: '更新后台未接入，版本发布不可用',
      to: '/release',
      action: '查看',
    })
  }
  if (security && !security.mfaEnabled) {
    alerts.push({
      level: 'warning',
      text: '两步验证（TOTP）未启用，建议尽快绑定',
      to: '/security',
      action: '去启用',
    })
  }

  return (
    <>
      <AdminHeader title='概览' />
      <Main>
        {/* KPI 数据带：四个指标一卡并列，分割线分组 */}
        <Card className='overflow-hidden py-0'>
          <div className='grid grid-cols-2 divide-x divide-y border-b sm:divide-y-0 lg:grid-cols-4'>
            <Kpi
              loading={isLoading}
              icon={<Users className='size-4' />}
              label='注册同学'
              value={o?.users}
              hint={`${data?.users.filter((u) => u.disabled).length ?? 0} 个已停用`}
            />
            <Kpi
              loading={isLoading}
              icon={<Zap className='size-4' />}
              label='在线实例'
              value={o ? `${o.online}/${o.capacity}` : undefined}
              hint={`并发上限 ${o?.capacity ?? '—'}`}
            />
            <Kpi
              loading={isLoading}
              icon={<Ticket className='size-4' />}
              label='可用邀请码'
              value={o?.invitesLeft}
              hint={`${data?.invites.length ?? 0} 个全量记录`}
            />
            <Kpi
              loading={isLoading}
              icon={<Rocket className='size-4' />}
              label='今日对话轮数'
              value={o ? String(o.turnsToday) : undefined}
              hint={o?.ownTurnsToday ? `另有自用 Key ${o.ownTurnsToday} 轮（不限额）` : '站点额度账'}
              extra={
                o && o.ownTurnsToday > 0 ? (
                  <span className='text-secondary-foreground bg-secondary rounded px-1 py-0.5 text-[11px] font-medium'>
                    +自{o.ownTurnsToday}
                  </span>
                ) : null
              }
            />
          </div>
          {site && site.deepseekKeyMasked && (
            <div className='text-muted-foreground flex items-center gap-2 px-6 py-2.5 text-xs'>
              <KeyRound className='size-3.5' />
              站点 Key：{site.deepseekKeyMasked}
              <span className='text-muted-foreground/60'>
                （新拉起的实例生效）
              </span>
            </div>
          )}
        </Card>

        {/* 待办 */}
        <Card className='mt-4'>
          <CardHeader className='pb-3'>
            <CardTitle>状态与待办</CardTitle>
            <CardDescription>需要留意的站点状态</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {isLoading && <Skeleton className='h-10 w-full' />}
            {data &&
              (alerts.length === 0 ? (
                <div className='flex items-center gap-2.5 rounded-lg border border-primary/15 bg-primary/5 px-3.5 py-3 text-sm'>
                  <CheckCircle2 className='size-4 text-primary' />
                  <span>一切正常，没有待办。</span>
                </div>
              ) : (
                alerts.map((a) => (
                  <div
                    key={a.text}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 ${
                      a.level === 'danger'
                        ? 'border-destructive/25 bg-destructive/5'
                        : a.level === 'warning'
                          ? 'border-amber-500/25 bg-amber-500/5'
                          : 'border-border bg-muted/40'
                    }`}
                  >
                    <div className='flex min-w-0 items-center gap-2.5 text-sm'>
                      <AlertTriangle
                        className={`size-4 shrink-0 ${
                          a.level === 'danger'
                            ? 'text-destructive'
                            : a.level === 'warning'
                              ? 'text-amber-500'
                              : 'text-muted-foreground'
                        }`}
                      />
                      <span className='truncate'>{a.text}</span>
                    </div>
                    <Button asChild variant='outline' size='sm' className='shrink-0'>
                      <Link to={a.to}>
                        {a.action}
                        <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                ))
              ))}
          </CardContent>
        </Card>

        <div className='mt-4 grid gap-4 lg:grid-cols-5'>
          {/* 快捷操作 */}
          <Card className='lg:col-span-2'>
            <CardHeader className='pb-3'>
              <CardTitle>快捷操作</CardTitle>
            </CardHeader>
            <CardContent className='grid grid-cols-2 gap-2'>
              <QuickLink to='/invites' icon={<Ticket />}>
                生成邀请码
              </QuickLink>
              <QuickLink to='/users' icon={<Users />}>
                新增用户
              </QuickLink>
              <QuickLink to='/release' icon={<Rocket />}>
                上传版本
              </QuickLink>
              <QuickLink to='/site' icon={<Settings2 />}>
                站点 Key
              </QuickLink>
              <QuickLink to='/security' icon={<ShieldCheck />} className='col-span-2'>
                两步验证
              </QuickLink>
            </CardContent>
          </Card>

          {/* 最近操作 */}
          <Card className='lg:col-span-3'>
            <CardHeader className='flex-row items-center justify-between pb-3'>
              <CardTitle>最近操作</CardTitle>
              <Button asChild variant='ghost' size='sm'>
                <Link to='/log'>
                  全部
                  <ArrowRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className='px-3 pb-3'>
              {isLoading && (
                <div className='flex flex-col gap-2'>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className='h-7 w-full' />
                  ))}
                </div>
              )}
              {data && data.log.length === 0 && (
                <p className='text-muted-foreground px-3 py-6 text-center text-sm'>
                  暂无记录——做过一次管理动作就会出现在这里
                </p>
              )}
              <ul className='space-y-0.5'>
                {data?.log.slice(0, 8).map((entry, i) => (
                  <li
                    key={`${entry.at}-${i}`}
                    className='hover:bg-muted/50 flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm transition-colors'
                  >
                    <span className='min-w-0 truncate'>{entry.text}</span>
                    <span className='text-muted-foreground shrink-0 font-mono text-xs tabular-nums'>
                      {fmtDateTime(entry.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}

function Kpi({
  loading,
  icon,
  label,
  value,
  hint,
  extra,
}: {
  loading?: boolean
  icon: React.ReactNode
  label: string
  value: string | number | undefined
  hint: string
  extra?: React.ReactNode
}) {
  return (
    <div className='flex flex-col gap-2 px-6 py-5'>
      <div className='text-muted-foreground flex items-center gap-2 text-xs font-medium'>
        <span className='bg-primary/10 text-primary flex size-6 items-center justify-center rounded-md'>
          {icon}
        </span>
        {label}
      </div>
      <div className='flex items-baseline gap-1.5'>
        <span className='text-3xl font-bold tracking-tight tabular-nums'>
          {loading || value === undefined ? (
            <Skeleton className='h-9 w-16' />
          ) : (
            value
          )}
        </span>
        {extra}
      </div>
      <p className='text-muted-foreground/70 text-xs'>{hint}</p>
    </div>
  )
}

function QuickLink({
  to,
  icon,
  children,
  className,
}: {
  to: string
  icon: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Button
      asChild
      variant='outline'
      className={`h-auto justify-start gap-2.5 px-3.5 py-2.5 text-[13px] ${className ?? ''}`}
    >
      <Link to={to}>
        <span className='text-primary'>{icon}</span>
        {children}
      </Link>
    </Button>
  )
}
