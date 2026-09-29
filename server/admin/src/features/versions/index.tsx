import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PackageOpen, History, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, type VersionEntry } from '@/lib/api'
import { formatBytes, formatTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import useDialogState from '@/hooks/use-dialog-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'

type PendingAction =
  | { kind: 'rollback'; entry: VersionEntry }
  | { kind: 'delete'; entry: VersionEntry }

export function Versions() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useDialogState()
  const [pending, setPending] = useState<PendingAction | null>(null)
  const { data, isPending } = useQuery({
    queryKey: ['versions'],
    queryFn: api.versions,
  })

  const refresh = () => queryClient.invalidateQueries()

  const rollbackMutation = useMutation({
    mutationFn: (version: string) => api.rollback(version),
    onSuccess: (_data, version) => {
      toast.success(`已回滚到 v${version}`, {
        description: '学生端将下载该版本',
      })
      refresh()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (version: string) => api.deleteVersion(version),
    onSuccess: (_data, version) => {
      toast.success(`v${version} 已删除`)
      refresh()
    },
  })

  function ask(action: PendingAction) {
    setPending(action)
    setOpen(true)
  }

  function handleConfirm() {
    if (!pending) return
    setOpen(false)
    if (pending.kind === 'rollback') rollbackMutation.mutate(pending.entry.version)
    else deleteMutation.mutate(pending.entry.version)
  }

  const versions = data?.versions ?? []
  const totalBytes = versions.reduce((sum, entry) => sum + entry.sizeBytes, 0)

  return (
    <Main>
      <PageHeader
        title='历史版本'
        description='服务器保留的全部安装包，可回滚当前分发版本或清理旧包'
      />

      {isPending ? (
        <Skeleton className='h-64 rounded-xl' />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>版本列表</CardTitle>
            <CardDescription>
              {versions.length > 0
                ? `共 ${versions.length} 个版本 · 磁盘占用 ${formatBytes(totalBytes)}；回滚把当前分发版本指回历史包`
                : '回滚把当前分发版本指回历史包'}
            </CardDescription>
          </CardHeader>
          {versions.length === 0 ? (
            <EmptyState
              icon={<PackageOpen className='size-6' />}
              title='还没有发布过版本'
              description='发布第一个安装包后，这里会展示全部历史记录'
              action={
                <Button asChild>
                  <Link to='/publish'>去发布新版本</Link>
                </Button>
              }
            />
          ) : (
            <div className='px-6 pb-6'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>版本</TableHead>
                    <TableHead>大小</TableHead>
                    <TableHead>发布时间</TableHead>
                    <TableHead className='max-w-64'>更新说明</TableHead>
                    <TableHead className='text-end'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((entry) => (
                    <TableRow key={entry.version}>
                      <TableCell className='font-mono font-medium'>
                        v{entry.version}
                        {entry.isCurrent && (
                          <Badge className='ms-2' variant='default'>
                            当前分发
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className='tabular-nums'>
                        {formatBytes(entry.sizeBytes)}
                      </TableCell>
                      <TableCell className='text-muted-foreground'>
                        {formatTime(entry.publishedAt)}
                      </TableCell>
                      <TableCell
                        className='max-w-64 truncate text-muted-foreground'
                        title={entry.notes}
                      >
                        {entry.notes || '—'}
                      </TableCell>
                      <TableCell className='text-end'>
                        {entry.isCurrent ? (
                          <span className='text-xs text-muted-foreground'>
                            分发中
                          </span>
                        ) : (
                          <div className='flex justify-end gap-1'>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  onClick={() =>
                                    ask({ kind: 'rollback', entry })
                                  }
                                  aria-label={`回滚到 v${entry.version}`}
                                >
                                  <History className='size-4' />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>回滚到此版本</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  onClick={() =>
                                    ask({ kind: 'delete', entry })
                                  }
                                  aria-label={`删除 v${entry.version}`}
                                >
                                  <Trash2 className='size-4 text-destructive' />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>删除此版本</TooltipContent>
                            </Tooltip>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(open)}
        onOpenChange={setOpen}
        title={pending?.kind === 'delete' ? '删除版本' : '回滚版本'}
        desc={
          pending?.kind === 'delete'
            ? `确定删除 v${pending.entry.version} 吗？安装包将从服务器移除，不可恢复。`
            : `确定回滚到 v${pending?.entry.version} 吗？学生端将下载该版本。`
        }
        confirmText={pending?.kind === 'delete' ? '删除' : '回滚'}
        destructive={pending?.kind === 'delete'}
        isLoading={
          rollbackMutation.isPending || deleteMutation.isPending
        }
        handleConfirm={handleConfirm}
        className='sm:max-w-sm'
      />
    </Main>
  )
}
