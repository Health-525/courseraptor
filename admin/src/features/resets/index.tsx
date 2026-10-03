import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Check, Copy, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import {
  resetApprove,
  resetReject,
  resetRevoke,
  type ResetCode,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtDateTime } from '@/lib/format'
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

/**
 * 重置审批：同意即生成一次性码（24h、用后即焚），经群转交同学自设新密码。
 * 管理员只经手码，永远不知道新密码（HANDOVER §4.2 既定语义）。
 */
export function ResetsPage() {
  const { data, isLoading } = useBootstrap()
  const invalidate = useInvalidateBootstrap()
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [approved, setApproved] = useState<ResetCode | null>(null)
  const [revoking, setRevoking] = useState<ResetCode | null>(null)

  const approve = useMutation({
    mutationFn: (id: string) => resetApprove(id),
    onSuccess: (res) => {
      setApproved({
        code: res.code,
        username: res.username,
        userId: '',
        createdAt: '',
        expiresAt: res.expiresAt,
      })
      void invalidate()
    },
  })

  const reject = useMutation({
    mutationFn: () => resetReject(rejecting!),
    onSuccess: () => {
      toast.success('已拒绝该申请')
      setRejecting(null)
      void invalidate()
    },
  })

  const revoke = useMutation({
    mutationFn: () => resetRevoke(revoking!.code),
    onSuccess: () => {
      toast.success(`已作废 ${revoking?.username} 的重置码`)
      setRevoking(null)
      void invalidate()
    },
  })

  const pending = data?.resets.pending ?? []
  const codes = data?.resets.codes ?? []
  // 过期与否本来就是时间敏感的展示，随 60s 轮询刷新重算即可
  // eslint-disable-next-line react-hooks/purity -- 刻意在渲染期取当前时间做过期标记
  const now = Date.now()

  return (
    <>
      <AdminHeader title='重置审批' pretitle='ADMIN · 管理' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>待审批申请</CardTitle>
            <CardDescription>
              同意后把一次性码发给同学，新密码由同学自己设（管理员经手码但不知道密码）
            </CardDescription>
          </CardHeader>
          <CardContent className='px-0'>
            {isLoading && <Skeleton className='mx-6 mb-4 h-16 w-full' />}
            {data && (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户名</TableHead>
                      <TableHead>申请时间</TableHead>
                      <TableHead className='w-56' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className='text-muted-foreground py-8 text-center'
                        >
                          没有待审批的申请
                        </TableCell>
                      </TableRow>
                    )}
                    {pending.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className='font-mono font-semibold'>
                          {r.username}
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>
                          {fmtDateTime(r.requestedAt)}
                        </TableCell>
                        <TableCell>
                          <div className='flex justify-end gap-2'>
                            <Button
                              size='sm'
                              disabled={approve.isPending}
                              onClick={() => approve.mutate(r.id)}
                            >
                              <Check />
                              同意并生成码
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => setRejecting(r.id)}
                            >
                              <X />
                              拒绝
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>有效重置码</CardTitle>
            <CardDescription>
              24 小时内有效 · 用后即焚 · 发错人或码外泄可立即作废
            </CardDescription>
          </CardHeader>
          <CardContent className='px-0'>
            {isLoading && <Skeleton className='mx-6 mb-4 h-16 w-full' />}
            {data && (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户名</TableHead>
                      <TableHead>重置码</TableHead>
                      <TableHead>过期时间</TableHead>
                      <TableHead className='w-24' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {codes.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className='text-muted-foreground py-8 text-center'
                        >
                          暂无有效重置码
                        </TableCell>
                      </TableRow>
                    )}
                    {codes.map((c) => {
                      const expired = new Date(c.expiresAt).getTime() < now
                      return (
                        <TableRow key={c.code}>
                          <TableCell className='font-mono font-semibold'>
                            {c.username}
                          </TableCell>
                          <TableCell className='font-mono font-bold'>
                            {c.code}
                          </TableCell>
                          <TableCell className='text-muted-foreground text-xs'>
                            {expired ? (
                              <span className='text-destructive'>已过期</span>
                            ) : (
                              `至 ${fmtDateTime(c.expiresAt)}`
                            )}
                          </TableCell>
                          <TableCell>
                            {!expired && (
                              <div className='flex justify-end gap-1'>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='size-8'
                                  aria-label='复制重置码'
                                  onClick={() => void copyText(c.code)}
                                >
                                  <Copy />
                                </Button>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='text-destructive size-8'
                                  aria-label='作废重置码'
                                  onClick={() => setRevoking(c)}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 同意后展示一次性码 */}
        <Dialog
          open={approved !== null}
          onOpenChange={(v) => !v && setApproved(null)}
        >
          <DialogContent className='sm:max-w-sm'>
            <DialogHeader>
              <DialogTitle>重置码已生成</DialogTitle>
              <DialogDescription>
                把这枚一次性码发给 {approved?.username}（24
                小时内有效，用后即焚）；同学用它自行设置新密码。
              </DialogDescription>
            </DialogHeader>
            <div className='flex gap-2'>
              <Input
                readOnly
                value={approved?.code ?? ''}
                className='font-mono font-bold'
              />
              <Button
                variant='outline'
                className='shrink-0'
                onClick={() => void copyText(approved?.code ?? '')}
              >
                <Copy />
                复制
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => setApproved(null)}>我已保存，关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={rejecting !== null}
          onOpenChange={(v) => !v && setRejecting(null)}
          title='拒绝申请'
          desc='确定拒绝这条密码重置申请吗？同学需要重新提交申请。'
          cancelBtnText='取消'
          confirmText='拒绝'
          destructive
          isLoading={reject.isPending}
          handleConfirm={() => reject.mutate()}
          className='sm:max-w-sm'
        />

        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(v) => !v && setRevoking(null)}
          title='作废重置码'
          desc={`确定作废 ${revoking?.username} 的这枚重置码吗？作废后码立即失效，同学需重新申请。`}
          cancelBtnText='取消'
          confirmText='作废'
          destructive
          isLoading={revoke.isPending}
          handleConfirm={() => revoke.mutate()}
          className='sm:max-w-sm'
        />
      </Main>
    </>
  )
}
