import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  KeyRound,
  Rocket,
  Settings2,
  ShieldCheck,
  Ticket,
  Users,
} from 'lucide-react'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap } from '@/lib/admin-data'
import { fmtDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

/** 概览：统计卡 + 待办提醒 + 快捷操作 + 最近操作（与旧管理台首页对齐） */
export function Overview() {
  const { data, isLoading } = useBootstrap()

  const o = data?.overview
  const site = data?.site
  const security = data?.security
  const updateOverview = data?.update?.overview

  const alerts: {
    level: 'warning' | 'danger' | 'info'
    text: string
    to: string
    action: string
  }[] = []
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
        {/* 统计卡 */}
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          <StatCard
            label='注册同学'
            value={o?.users}
            icon={<Users className='text-muted-foreground/60 size-4' />}
          />
          <StatCard
            label='在线实例'
            value={o ? `${o.online}/${o.capacity}` : undefined}
            icon={<BadgeCheck className='text-muted-foreground/60 size-4' />}
          />
          <StatCard
            label='可用邀请码'
            value={o?.invitesLeft}
            icon={<Ticket className='text-muted-foreground/60 size-4' />}
          />
          <StatCard
            label='今日对话轮数'
            value={
              o
                ? o.ownTurnsToday > 0
                  ? `${o.turnsToday}（+自用 ${o.ownTurnsToday}）`
                  : String(o.turnsToday)
                : undefined
            }
            icon={<Rocket className='text-muted-foreground/60 size-4' />}
          />
        </div>

        {/* 待办提醒 */}
        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>状态与待办</CardTitle>
            <CardDescription>需要留意的站点状态</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {isLoading && <Skeleton className='h-8 w-full' />}
            {data &&
              (alerts.length === 0 ? (
                <p className='text-sm text-green-600 dark:text-green-400'>
                  ✓ 一切正常，没有待办。
                </p>
              ) : (
                alerts.map((a) => (
                  <div
                    key={a.text}
                    className='flex items-center justify-between gap-3 rounded-md border px-3 py-2'
                  >
                    <div className='flex min-w-0 items-center gap-2 text-sm'>
                      <AlertTriangle
                        className={
                          a.level === 'danger'
                            ? 'size-4 shrink-0 text-red-500'
                            : a.level === 'warning'
                              ? 'size-4 shrink-0 text-amber-500'
                              : 'text-muted-foreground size-4 shrink-0'
                        }
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

        <div className='mt-4 grid gap-4 lg:grid-cols-2'>
          {/* 快捷操作 */}
          <Card>
            <CardHeader>
              <CardTitle>快捷操作</CardTitle>
            </CardHeader>
            <CardContent className='flex flex-wrap gap-2'>
              <Button asChild variant='outline'>
                <Link to='/invites'>
                  <Ticket />
                  生成邀请码
                </Link>
              </Button>
              <Button asChild variant='outline'>
                <Link to='/users'>
                  <Users />
                  新增用户
                </Link>
              </Button>
              <Button asChild variant='outline'>
                <Link to='/release'>
                  <Rocket />
                  上传版本
                </Link>
              </Button>
              <Button asChild variant='outline'>
                <Link to='/site'>
                  <Settings2 />
                  站点 Key
                </Link>
              </Button>
              <Button asChild variant='outline'>
                <Link to='/security'>
                  <ShieldCheck />
                  两步验证
                </Link>
              </Button>
            </CardContent>
          </Card>

          {/* 最近操作 */}
          <Card>
            <CardHeader className='flex-row items-center justify-between'>
              <CardTitle>最近操作</CardTitle>
              <Button asChild variant='ghost' size='sm'>
                <Link to='/log'>
                  全部
                  <ArrowRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className='px-0 pb-2'>
              {isLoading && (
                <div className='flex flex-col gap-2'>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className='mx-6 h-5 w-full' />
                  ))}
                </div>
              )}
              {data && data.log.length === 0 && (
                <p className='text-muted-foreground px-6 text-sm'>暂无记录</p>
              )}
              <ul className='divide-y'>
                {data?.log.slice(0, 8).map((entry, i) => (
                  <li
                    key={`${entry.at}-${i}`}
                    className='flex items-center justify-between gap-3 px-6 py-2 text-sm'
                  >
                    <span className='min-w-0 truncate'>{entry.text}</span>
                    <span className='text-muted-foreground shrink-0 text-xs'>
                      {fmtDateTime(entry.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* 密钥状态提示（概览里顺带可见） */}
        {site && site.deepseekKeyMasked && (
          <div className='mt-4'>
            <Badge variant='secondary'>
              <KeyRound />
              站点 Key：{site.deepseekKeyMasked}
            </Badge>
          </div>
        )}
      </Main>
    </>
  )
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string | number | undefined
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className='flex items-center gap-1.5'>
          {icon}
          {label}
        </CardDescription>
        <CardTitle className='text-2xl font-bold tabular-nums'>
          {value ?? <Skeleton className='h-8 w-16' />}
        </CardTitle>
      </CardHeader>
    </Card>
  )
}
