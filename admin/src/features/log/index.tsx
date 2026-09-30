import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap } from '@/lib/admin-data'
import { fmtDateTime } from '@/lib/format'
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

/** 操作日志：最近 200 条管理动作（环形 500 条，等落盘再响应） */
export function LogPage() {
  const { data, isLoading } = useBootstrap()

  return (
    <>
      <AdminHeader title='操作日志' pretitle='ADMIN · 系统' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>管理动作记录</CardTitle>
            <CardDescription>最近 200 条 · 全量存于服务器 admin-log.json</CardDescription>
          </CardHeader>
          <CardContent className='px-0'>
            {isLoading && (
              <div className='flex flex-col gap-2 px-6 pb-4'>
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className='h-8 w-full' />
                ))}
              </div>
            )}
            {data && (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-40'>时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.log.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={2} className='text-muted-foreground py-8 text-center'>
                          暂无记录
                        </TableCell>
                      </TableRow>
                    )}
                    {data.log.map((entry, i) => (
                      <TableRow key={`${entry.at}-${i}`}>
                        <TableCell className='text-muted-foreground whitespace-nowrap text-xs'>
                          {fmtDateTime(entry.at)}
                        </TableCell>
                        <TableCell>{entry.text}</TableCell>
                      </TableRow>
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
