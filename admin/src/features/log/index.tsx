import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { logClear } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/** 操作日志：最近 200 条管理动作（环形 500 条，等落盘再响应），可整体清空 */
export function LogPage() {
  const { data, isLoading } = useBootstrap()
  const invalidate = useInvalidateBootstrap()
  const [clearing, setClearing] = useState(false)

  const clear = useMutation({
    mutationFn: () => logClear(),
    onSuccess: () => {
      toast.success('操作日志已清空')
      setClearing(false)
      void invalidate()
    },
  })

  return (
    <>
      <AdminHeader title='操作日志' pretitle='ADMIN · 系统' />
      <Main>
        <Card>
          <CardHeader className='gap-4 sm:flex-row sm:items-center sm:justify-between'>
            <div className='space-y-1.5'>
              <CardTitle>管理动作记录</CardTitle>
              <CardDescription>
                最近 200 条 · 全量存于服务器 admin-log.json
              </CardDescription>
            </div>
            {data && data.log.length > 0 && (
              <Button
                size='sm'
                variant='outline'
                className='text-destructive'
                onClick={() => setClearing(true)}
              >
                <Trash2 />
                清空日志
              </Button>
            )}
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

        <ConfirmDialog
          open={clearing}
          onOpenChange={setClearing}
          title='清空操作日志'
          desc='确定清空全部操作日志吗？清空后从零开始记录（清空动作本身会留一笔）。'
          cancelBtnText='取消'
          confirmText='清空'
          destructive
          isLoading={clear.isPending}
          handleConfirm={() => clear.mutate()}
          className='sm:max-w-sm'
        />
      </Main>
    </>
  )
}
