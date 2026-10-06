import { BadgeDollarSign, KeyRound, Ticket, UsersRound } from 'lucide-react'
import { useBootstrap } from '@/lib/admin-data'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { Overview } from './components/overview'
import { RecentActions } from './components/recent-actions'

export function Dashboard() {
  const { data, isLoading } = useBootstrap()
  const o = data?.overview

  const disabledCount = (data?.users ?? []).filter((u) => u.disabled).length

  const kpis = [
    {
      title: '注册同学',
      value: String(o?.users ?? '—'),
      sub: disabledCount > 0 ? `${disabledCount} 个已停用` : '全部正常',
      icon: <UsersRound className='h-4 w-4 text-muted-foreground' />,
    },
    {
      title: '在线实例',
      value: `${o?.online ?? 0}/${o?.capacity ?? '—'}`,
      sub: '并发上限即此分母',
      icon: <KeyRound className='h-4 w-4 text-muted-foreground' />,
    },
    {
      title: '可用邀请码',
      value: String(o?.invitesLeft ?? '—'),
      sub: `${data?.invites.length ?? 0} 个全量记录`,
      icon: <Ticket className='h-4 w-4 text-muted-foreground' />,
    },
    {
      title: '今日对话轮数',
      value: String(o?.turnsToday ?? '—'),
      sub: `站点额度账${o?.ownTurnsToday ? ` · 自有 ${o.ownTurnsToday} 轮` : ''}`,
      icon: <BadgeDollarSign className='h-4 w-4 text-muted-foreground' />,
    },
  ]

  return (
    <>
      <AdminHeader title='总览' pretitle='ADMIN · 总览' />

      <Main className='space-y-4 sm:space-y-6'>
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          {kpis.map((kpi) => (
            <Card key={kpi.title}>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  {kpi.title}
                </CardTitle>
                {kpi.icon}
              </CardHeader>
              <CardContent>
                <div className='text-2xl font-bold tabular-nums'>
                  {isLoading ? '…' : kpi.value}
                </div>
                <p className='text-xs text-muted-foreground'>{kpi.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className='grid grid-cols-1 gap-4 lg:grid-cols-7'>
          <Card className='col-span-4'>
            <CardHeader>
              <CardTitle>今日站点额度用量</CardTitle>
              <CardDescription>
                各同学今天用站点 Key 的对话轮数（按量排序）
              </CardDescription>
            </CardHeader>
            <CardContent className='px-3'>
              <Overview />
            </CardContent>
          </Card>
          <Card className='col-span-3'>
            <CardHeader>
              <CardTitle>最近操作</CardTitle>
              <CardDescription>管理动作实时记录</CardDescription>
            </CardHeader>
            <CardContent>
              <RecentActions />
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}
