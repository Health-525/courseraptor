import { useQuery } from '@tanstack/react-query'
import { MonitorSmartphone } from 'lucide-react'
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { localUsageGet, type LocalUsageStats } from '@/lib/api'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'

/** 单个 KPI 卡：数值 + 说明（无图标态也成立，保持总览页的卡片密度） */
function KpiCard({
  title,
  value,
  sub,
}: {
  title: string
  value: string
  sub?: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className='text-2xl tabular-nums'>{value}</CardTitle>
        {sub && <p className='text-muted-foreground text-xs'>{sub}</p>}
      </CardHeader>
    </Card>
  )
}

/** 版本分布条形图（数据形状与总览柱图一致，直接复用同一套 recharts 画法） */
function VersionChart({ stats }: { stats: LocalUsageStats }) {
  if (stats.versions.length === 0) return null
  return (
    <ResponsiveContainer width='100%' height={220}>
      <BarChart data={stats.versions}>
        <XAxis
          dataKey='name'
          stroke='#888888'
          fontSize={12}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke='#888888'
          fontSize={12}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Bar dataKey='count' radius={[4, 4, 0, 0]} className='fill-primary' />
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * 本地版监控：下载安装包（TUI/exe）的匿名使用统计。
 * 数据源是客户端 24h 一次的匿名上报（随机设备号+版本+平台，无任何个人信息），
 * 「活跃」口径 = 统计窗口内有过上报；旧版本安装包没有上报逻辑，装了也不计。
 */
export function LocalUsagePage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['local-usage'],
    queryFn: localUsageGet,
    refetchInterval: 60_000,
  })

  return (
    <>
      <AdminHeader title='本地版监控' pretitle='ADMIN · 系统' />
      <Main>
        {isLoading && (
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className='h-28 w-full' />
            ))}
          </div>
        )}
        {isError && (
          <Card>
            <CardContent className='text-muted-foreground py-10 text-center text-sm'>
              读取失败：{(error as Error)?.message ?? '未知错误'}
            </CardContent>
          </Card>
        )}
        {data && (
          <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
              <KpiCard
                title='累计设备'
                value={String(data.total)}
                sub='自统计上线以来的去重设备号'
              />
              <KpiCard
                title='今日活跃'
                value={String(data.activeToday)}
                sub='按北京时间切日'
              />
              <KpiCard title='7 天活跃' value={String(data.active7d)} />
              <KpiCard title='30 天活跃' value={String(data.active30d)} />
            </div>

            <Card>
              <CardHeader className='gap-4 sm:flex-row sm:items-center sm:justify-between'>
                <div className='space-y-1.5'>
                  <CardTitle>版本分布</CardTitle>
                  <CardDescription>
                    最近一次上报：
                    {data.lastPingAt ? fmtRelative(data.lastPingAt) : '—'}
                  </CardDescription>
                </div>
                <div className='text-muted-foreground flex items-center gap-1.5 text-xs'>
                  <MonitorSmartphone className='h-3.5 w-3.5' />
                  {data.platforms
                    .map((p) => `${p.name} ×${p.count}`)
                    .join(' · ') || '—'}
                </div>
              </CardHeader>
              <CardContent>
                {data.total === 0 ? (
                  <div className='text-muted-foreground flex h-32 items-center justify-center text-sm'>
                    还没有本地版上报——发一版带统计的新安装包后，这里开始计数
                  </div>
                ) : (
                  <VersionChart stats={data} />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>最近活跃设备</CardTitle>
                <CardDescription>
                  按最近上报排序的前 100 台 · 设备号是随机码，只取前 8 位展示
                </CardDescription>
              </CardHeader>
              <CardContent className='px-0'>
                <div className='overflow-x-auto'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='w-28'>设备</TableHead>
                        <TableHead className='w-24'>版本</TableHead>
                        <TableHead className='w-20'>平台</TableHead>
                        <TableHead className='w-40'>首次活跃</TableHead>
                        <TableHead className='w-40'>最近活跃</TableHead>
                        <TableHead className='w-20 text-right'>
                          上报次数
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.recent.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={6}
                            className='text-muted-foreground py-8 text-center'
                          >
                            暂无记录
                          </TableCell>
                        </TableRow>
                      )}
                      {data.recent.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className='font-mono text-xs'>
                            {c.id}…
                          </TableCell>
                          <TableCell>v{c.version}</TableCell>
                          <TableCell className='text-muted-foreground'>
                            {c.platform}
                          </TableCell>
                          <TableCell className='text-muted-foreground text-xs whitespace-nowrap'>
                            {fmtDateTime(c.firstSeen)}
                          </TableCell>
                          <TableCell className='text-muted-foreground text-xs whitespace-nowrap'>
                            {fmtDateTime(c.lastSeen)}
                          </TableCell>
                          <TableCell className='text-right tabular-nums'>
                            {c.pings}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </Main>
    </>
  )
}
