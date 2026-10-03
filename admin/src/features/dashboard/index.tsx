import { Link } from '@tanstack/react-router'
import { BadgeDollarSign, KeyRound, Ticket, UsersRound } from 'lucide-react'
import { useBootstrap } from '@/lib/admin-data'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { Overview } from './components/overview'
import { RecentSales } from './components/recent-sales'

export function Dashboard() {
  const { data, isLoading } = useBootstrap()
  const o = data?.overview

  const disabledCount = (data?.users ?? []).filter((u) => u.disabled).length

  const kpis = [
    {
      title: '注册同学',
      value: String(o?.users ?? '—'),
      sub: disabledCount > 0 ? `${disabledCount} 个已停用` : '全部正常',
      icon: <UsersRound className='text-muted-foreground h-4 w-4' />,
    },
    {
      title: '在线实例',
      value: `${o?.online ?? 0}/${o?.capacity ?? '—'}`,
      sub: '并发上限即此分母',
      icon: <KeyRound className='text-muted-foreground h-4 w-4' />,
    },
    {
      title: '可用邀请码',
      value: String(o?.invitesLeft ?? '—'),
      sub: `${data?.invites.length ?? 0} 个全量记录`,
      icon: <Ticket className='text-muted-foreground h-4 w-4' />,
    },
    {
      title: '今日对话轮数',
      value: String(o?.turnsToday ?? '—'),
      sub: `站点额度账${o?.ownTurnsToday ? ` · 自有 ${o.ownTurnsToday} 轮` : ''}`,
      icon: <BadgeDollarSign className='text-muted-foreground h-4 w-4' />,
    },
  ]

  return (
    <>
      {/* ===== Top Heading ===== */}
      <Header>
        <Search />
        <div className='ms-auto flex items-center space-x-4'>
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      {/* ===== Main ===== */}
      <Main>
        <div className='mb-2 flex items-center justify-between space-y-2'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>总览</h1>
            <p className='text-muted-foreground'>
              CourseRaptor 多用户服务 · v{o?.version ?? '—'} · 运行{' '}
              {Math.floor((o?.uptimeSec ?? 0) / 60)} 分钟
            </p>
          </div>
        </div>
        <Tabs
          orientation='vertical'
          defaultValue='overview'
          className='space-y-4'
        >
          <div className='w-full overflow-x-auto pb-2'>
            <TabsList>
              <TabsTrigger value='overview'>概览</TabsTrigger>
              <TabsTrigger value='status' disabled>
                状态
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value='overview' className='space-y-4'>
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
                    <p className='text-muted-foreground text-xs'>{kpi.sub}</p>
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
                  <CardDescription>
                    管理动作实时记录，全部见{' '}
                    <Link
                      to='/log'
                      className='hover:text-primary underline underline-offset-4'
                    >
                      操作日志
                    </Link>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <RecentSales />
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </Main>
    </>
  )
}
