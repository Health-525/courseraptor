import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownUp, Coins } from 'lucide-react'
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { tokenUsageGet, type TokenUsageStats } from '@/lib/api'
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
import { SelectDropdown } from '@/components/select-dropdown'

/** token 数的中文缩写：1.23 亿 / 4.5 万 / 678 */
function fmtTokens(n: number): string {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')} 亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`
  return String(Math.round(v))
}

const RANGE_OPTIONS = [
  { label: '近 7 天', value: '7' },
  { label: '近 30 天', value: '30' },
  { label: '近 90 天', value: '90' },
  { label: '全部（90 天）', value: 'all' },
]

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
        {sub && <p className='text-xs text-muted-foreground'>{sub}</p>}
      </CardHeader>
    </Card>
  )
}

/** 按天用量柱图（X 轴日期抽稀，避免 90 天挤成一团） */
function DaysChart({ stats }: { stats: TokenUsageStats }) {
  const data = stats.days.map((d) => ({
    name: d.date.slice(5).replace('-', '/'),
    total: d.total,
  }))
  return (
    <ResponsiveContainer width='100%' height={240}>
      <BarChart data={data}>
        <XAxis
          dataKey='name'
          stroke='#888888'
          fontSize={11}
          tickLine={false}
          axisLine={false}
          interval='preserveStartEnd'
          minTickGap={24}
        />
        <YAxis
          stroke='#888888'
          fontSize={12}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => fmtTokens(v)}
          direction='ltr'
        />
        <Bar dataKey='total' radius={[4, 4, 0, 0]} className='fill-primary' />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** 排行表：用户 / 模型两个维度共用，行 = 名称 + 总量 + 输入输出明细 + 占比 */
function RankTable({
  rows,
  labelKey,
}: {
  rows: Array<Record<string, string | number>>
  labelKey: 'username' | 'model'
}) {
  const sum = rows.reduce((acc, r) => acc + (Number(r.total) || 0), 0)
  return (
    <div className='overflow-x-auto'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className='w-48'>
              {labelKey === 'username' ? '同学' : '模型'}
            </TableHead>
            <TableHead className='text-right'>总 token</TableHead>
            <TableHead className='text-right'>输入 / 输出</TableHead>
            <TableHead className='w-32 text-right'>占比</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={4}
                className='py-8 text-center text-muted-foreground'
              >
                窗口内没有记录
              </TableCell>
            </TableRow>
          )}
          {rows.map((r) => (
            <TableRow key={String(r[labelKey === 'username' ? 'id' : 'model'])}>
              <TableCell className='max-w-48 truncate font-mono text-xs'>
                {String(r[labelKey])}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {fmtTokens(Number(r.total))}
              </TableCell>
              <TableCell className='text-right text-xs text-muted-foreground tabular-nums'>
                {fmtTokens(Number(r.in))} / {fmtTokens(Number(r.out))}
              </TableCell>
              <TableCell className='text-right text-muted-foreground tabular-nums'>
                {sum > 0
                  ? `${Math.round((Number(r.total) / sum) * 100)}%`
                  : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * Token 用量统计：同学实例每次 LLM 调用的 usage 上报（网关账本按
 * 天 × 用户 × 模型聚合，保留 90 天）。筛选条三向联动：
 * 时间范围 × 用户 × 模型；排行表分别忽略自身维度的筛选——选了模型
 * 看「谁用它最多」，选了用户看「TA 用什么最多」。
 */
export function TokenUsagePage() {
  const [range, setRange] = useState('30')
  const [user, setUser] = useState('')
  const [model, setModel] = useState('')

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['token-usage', range, user, model],
    queryFn: () => tokenUsageGet(range, user, model),
    refetchInterval: 60_000,
  })

  const userItems = [
    { label: '全部同学', value: '' },
    ...(data?.facets.users ?? []).map((u) => ({
      label: u.username,
      value: u.id,
    })),
  ]
  const modelItems = [
    { label: '全部模型', value: '' },
    ...(data?.facets.models ?? []).map((m) => ({ label: m, value: m })),
  ]

  return (
    <>
      <AdminHeader title='Token 用量' pretitle='ADMIN · 系统' />
      <Main>
        {isLoading && (
          <div className='space-y-4'>
            <Skeleton className='h-9 w-96' />
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className='h-28 w-full' />
              ))}
            </div>
            <Skeleton className='h-64 w-full' />
          </div>
        )}
        {isError && (
          <Card>
            <CardContent className='py-10 text-center text-sm text-muted-foreground'>
              读取失败：{(error as Error)?.message ?? '未知错误'}
            </CardContent>
          </Card>
        )}
        {data && (
          <div className='space-y-4'>
            <Card>
              <CardContent className='flex flex-wrap items-center gap-2 py-4'>
                <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
                  <Coins className='h-3.5 w-3.5' />
                  筛选：
                </span>
                <SelectDropdown
                  isControlled
                  defaultValue={range}
                  onValueChange={setRange}
                  items={RANGE_OPTIONS}
                  className='w-36'
                />
                <SelectDropdown
                  isControlled
                  defaultValue={user}
                  onValueChange={setUser}
                  items={userItems}
                  placeholder='同学'
                  className='w-40'
                />
                <SelectDropdown
                  isControlled
                  defaultValue={model}
                  onValueChange={setModel}
                  items={modelItems}
                  placeholder='模型'
                  className='w-56'
                />
                <span className='flex items-center gap-1 text-xs text-muted-foreground'>
                  <ArrowDownUp className='h-3 w-3' />
                  {data.from} ~ {data.to}
                </span>
              </CardContent>
            </Card>

            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
              <KpiCard
                title='窗口总量'
                value={fmtTokens(data.total.total)}
                sub={`当前筛选口径（${data.from} 起）`}
              />
              <KpiCard
                title='输入 token'
                value={fmtTokens(data.total.in)}
                sub='提示词与上下文'
              />
              <KpiCard
                title='输出 token'
                value={fmtTokens(data.total.out)}
                sub='回答与工具调用'
              />
              <KpiCard
                title='今日全站'
                value={fmtTokens(data.days[data.days.length - 1]?.total ?? 0)}
                sub='按北京时间切日'
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>每日用量</CardTitle>
                <CardDescription>
                  窗口内逐日 token 总量（当前筛选口径；账本保留 90 天）
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.total.total === 0 ? (
                  <div className='flex h-32 items-center justify-center text-sm text-muted-foreground'>
                    还没有实例上报——部署后同学发起一轮对话，这里开始计数
                  </div>
                ) : (
                  <DaysChart stats={data} />
                )}
              </CardContent>
            </Card>

            <div className='grid gap-4 lg:grid-cols-2'>
              <Card>
                <CardHeader>
                  <CardTitle>按同学</CardTitle>
                  <CardDescription>
                    选了模型时显示「谁用它最多」（不受同学筛选影响）
                  </CardDescription>
                </CardHeader>
                <CardContent className='px-0'>
                  <RankTable rows={data.byUser} labelKey='username' />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>按模型</CardTitle>
                  <CardDescription>
                    选了同学时显示「TA 用什么最多」（不受模型筛选影响）
                  </CardDescription>
                </CardHeader>
                <CardContent className='px-0'>
                  <RankTable rows={data.byModel} labelKey='model' />
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </Main>
    </>
  )
}
