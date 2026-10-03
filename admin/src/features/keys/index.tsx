import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { keyCreate, keyDelete } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Main } from '@/components/layout/main'

/** 密钥管理：更新后台的面板密钥（crak_ 前缀、明文仅此一次展示、与主密钥同权） */
export function KeysPage() {
  const { data, isLoading } = useBootstrap()
  const invalidate = useInvalidateBootstrap()
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null
  )

  const create = useMutation({
    mutationFn: () => keyCreate(name.trim()),
    onSuccess: (res) => {
      if (res.error) {
        toast.error(res.error)
        return
      }
      setCreated(res.data?.token ?? '')
      setName('')
      void invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: () => keyDelete(deleting!.id),
    onSuccess: (res) => {
      if (res.error) toast.error(res.error)
      else toast.success('密钥已删除（立即失效）')
      setDeleting(null)
      void invalidate()
    },
  })

  const keys = data?.update?.keys
  const unavailable = keys?.unavailable

  return (
    <>
      <AdminHeader title='密钥管理' pretitle='ADMIN · 发布' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>更新后台密钥</CardTitle>
            <CardDescription>
              命令行发版与后台登录用，与主密钥同权
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex gap-2'>
              <Input
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                placeholder='名称（可选），如：发布机 / 值班同学'
                autoComplete='off'
              />
              <Button
                className='shrink-0'
                disabled={create.isPending || unavailable === true}
                onClick={() => create.mutate()}
              >
                <KeyRound />
                新建密钥
              </Button>
            </div>

            {unavailable && (
              <p className='text-destructive text-sm'>
                {keys?.error}（版本发布与密钥管理都依赖更新后台）
              </p>
            )}

            {isLoading && <Skeleton className='h-32 w-full' />}

            {keys && !unavailable && (
              <div className='overflow-x-auto rounded-md border'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead>最后使用</TableHead>
                      <TableHead className='w-16' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(keys.data?.keys ?? []).length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className='text-muted-foreground py-8 text-center'
                        >
                          还没有面板密钥
                        </TableCell>
                      </TableRow>
                    )}
                    {(keys.data?.keys ?? []).map((k) => (
                      <TableRow key={k.id}>
                        <TableCell>{k.name || '—'}</TableCell>
                        <TableCell>
                          {k.isEnv ? (
                            <Badge variant='outline'>主密钥（env）</Badge>
                          ) : (
                            <Badge variant='secondary'>面板密钥</Badge>
                          )}
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>
                          {fmtDateTime(k.createdAt)}
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>
                          {k.lastUsedAt
                            ? fmtDateTime(k.lastUsedAt)
                            : '从未使用'}
                        </TableCell>
                        <TableCell>
                          {!k.isEnv && (
                            <Button
                              variant='ghost'
                              size='icon'
                              className='text-destructive size-8'
                              aria-label='删除密钥'
                              onClick={() =>
                                setDeleting({ id: k.id, name: k.name })
                              }
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className='text-muted-foreground text-xs'>
              主密钥来自服务器环境变量
              UPDATE_ADMIN_TOKEN，始终可用且不能在这里删除；面板密钥删除后立即失效。明文只在创建时展示一次。
            </p>
          </CardContent>
        </Card>

        {/* 一次性明文令牌 */}
        <Dialog
          open={created !== null}
          onOpenChange={(v) => !v && setCreated(null)}
        >
          <DialogContent className='sm:max-w-md'>
            <DialogHeader>
              <DialogTitle>密钥已创建（明文仅此一次展示）</DialogTitle>
              <DialogDescription>
                请立即复制保存。它不会再次出现，丢了只能删除后重建。
              </DialogDescription>
            </DialogHeader>
            <div className='flex gap-2'>
              <Input
                readOnly
                value={created ?? ''}
                className='font-mono text-xs'
              />
              <Button
                variant='outline'
                className='shrink-0'
                onClick={() => void copyText(created ?? '')}
              >
                <Copy />
                复制
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => setCreated(null)}>已保存，关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(v) => !v && setDeleting(null)}
          title='删除密钥'
          desc={`确定删除「${deleting?.name || deleting?.id}」吗？使用这枚密钥的命令行发版会立即失效。`}
          cancelBtnText='取消'
          confirmText='删除'
          destructive
          isLoading={remove.isPending}
          handleConfirm={() => remove.mutate()}
          className='sm:max-w-sm'
        />
      </Main>
    </>
  )
}
