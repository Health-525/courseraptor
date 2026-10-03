import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { useBootstrap } from '@/lib/admin-data'

/** 今日各同学用站点 Key 的轮数（降序取前 12，够画且不挤） */
export function Overview() {
  const { data } = useBootstrap()
  const today = new Date().toISOString().slice(0, 10)
  const rows = (data?.users ?? [])
    .map((u) => ({
      name: u.username,
      total: u.turns.date === today ? u.turns.count : 0,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12)

  if (rows.length === 0) {
    return (
      <div className='text-muted-foreground flex h-[350px] items-center justify-center text-sm'>
        今天还没有同学用站点额度对话
      </div>
    )
  }

  return (
    <ResponsiveContainer width='100%' height={350}>
      <BarChart data={rows}>
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
        <Bar
          dataKey='total'
          fill='currentColor'
          radius={[4, 4, 0, 0]}
          className='fill-primary'
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
