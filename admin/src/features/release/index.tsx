import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { FileArchive, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { updateDelete, updatePublish, updateRollback } from '@/lib/api'
import { fmtBytes, fmtDateTime, nextPatch } from '@/lib/format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { AdminHeader } from '@/components/admin-header'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Main } from '@/components/layout/main'

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/** 版本发布：网页上传 zip（流式转发到更新后台，支持进度与取消）+ 历史回滚 */
export function ReleasePage() {
  const { data, isLoading } = useBootstrap()
  const invalidate = useInvalidateBootstrap()

  // 上传状态
  const [version, setVersion] = useState('')
  const [versionTouched, setVersionTouched] = useState(false)
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragOn, setDragOn] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState({ loaded: 0, total: 0, phase: '' })
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [confirmRollback, setConfirmRollback] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // 历史分发里挑个「当前版本 +1」预填；用户手改过就不再覆盖（渲染期派生，不用 effect）
  const currentVersion = data?.update?.overview?.data?.current?.version ?? ''
  const displayVersion =
    versionTouched || !currentVersion ? version : nextPatch(currentVersion)

  const pickFile = (f: File | null | undefined) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.zip')) {
      toast.error('只支持 zip 安装包')
      return
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      toast.error('安装包超过 200 MB 上限')
      return
    }
    setFile(f)
  }

  const startUpload = async () => {
    if (!file || !/^\d+\.\d+\.\d+$/.test(displayVersion.trim())) return
    setUploading(true)
    setProgress({ loaded: 0, total: file.size, phase: '上传中' })
    const abort = new AbortController()
    abortRef.current = abort
    try {
      await updatePublish(file, displayVersion.trim(), notes.trim(), {
        signal: abort.signal,
        onProgress: (loaded, total) =>
          setProgress({ loaded, total, phase: '上传中' }),
      })
      toast.success(
        `v${displayVersion.trim()} 发布成功，学生端下次启动时提示更新`
      )
      setFile(null)
      setNotes('')
      setVersionTouched(false)
      void invalidate()
    } catch (err) {
      if (abort.signal.aborted) toast.info('已取消上传')
      else {
        const msg = (err as { response?: { data?: { error?: string } } })
          .response?.data?.error
        toast.error(msg ?? '发布失败')
      }
    } finally {
      setUploading(false)
      abortRef.current = null
    }
  }

  const rollback = useMutation({
    mutationFn: () => updateRollback(confirmRollback!),
    onSuccess: (res) => {
      if (res.error) toast.error(res.error)
      else {
        toast.success(`已回滚到 v${confirmRollback}`)
        void invalidate()
      }
      setConfirmRollback(null)
    },
  })

  const remove = useMutation({
    mutationFn: () => updateDelete(confirmDelete!),
    onSuccess: (res) => {
      if (res.error) toast.error(res.error)
      else {
        toast.success(`已删除 v${confirmDelete}`)
        void invalidate()
      }
      setConfirmDelete(null)
    },
  })

  const updOverview = data?.update?.overview
  const updVersions = data?.update?.versions

  return (
    <>
      <AdminHeader title='版本发布' pretitle='ADMIN · 发布' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>上传新版本</CardTitle>
            <CardDescription>
              同学端安装包 · 与 npm run publish 共用接口
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-3'>
            <div className='flex flex-wrap gap-3'>
              <div className='grid w-32 gap-1.5'>
                <Label htmlFor='rel-version'>版本号</Label>
                <Input
                  id='rel-version'
                  value={displayVersion}
                  onChange={(e) => {
                    setVersion(e.target.value)
                    setVersionTouched(true)
                  }}
                  placeholder='x.y.z'
                  className='text-center font-mono'
                  autoComplete='off'
                  spellCheck={false}
                />
              </div>
              <div className='grid min-w-56 flex-1 gap-1.5'>
                <Label htmlFor='rel-notes'>更新说明（可选）</Label>
                <Input
                  id='rel-notes'
                  value={notes}
                  maxLength={2000}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder='如：修复课表周次显示错误'
                  autoComplete='off'
                />
              </div>
            </div>

            {/* 拖放区（点击 / 键盘 / 拖入） */}
            <div
              role='button'
              tabIndex={0}
              aria-label='选择或拖入 zip 安装包'
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                dragOn
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:border-primary/50 hover:text-foreground'
              }`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ')
                  fileInputRef.current?.click()
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOn(true)
              }}
              onDragLeave={() => setDragOn(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOn(false)
                pickFile(e.dataTransfer.files?.[0])
              }}
            >
              <Upload className='size-6' />
              <p className='text-sm'>
                {file
                  ? '点击重新选择文件'
                  : '点击选择，或拖入 zip 安装包（最大 200 MB）'}
              </p>
            </div>
            <input
              ref={fileInputRef}
              type='file'
              accept='.zip,application/zip'
              hidden
              onChange={(e) => pickFile(e.target.files?.[0])}
            />

            {file && (
              <div className='flex items-center gap-2 rounded-md border px-3 py-2 text-sm'>
                <FileArchive className='size-4 shrink-0' />
                <span className='min-w-0 flex-1 truncate font-mono'>
                  {file.name}
                </span>
                <span className='text-muted-foreground shrink-0 text-xs'>
                  {fmtBytes(file.size)}
                </span>
                {!uploading && (
                  <Button
                    variant='ghost'
                    size='icon'
                    className='size-7'
                    aria-label='移除文件'
                    onClick={() => setFile(null)}
                  >
                    <X />
                  </Button>
                )}
              </div>
            )}

            {uploading && (
              <div className='space-y-1.5'>
                <div className='text-muted-foreground flex justify-between text-xs'>
                  <span>{progress.phase}</span>
                  <span>
                    {fmtBytes(progress.loaded)} /{' '}
                    {fmtBytes(progress.total || progress.loaded)}
                  </span>
                </div>
                <div className='bg-secondary h-2 overflow-hidden rounded-full'>
                  <div
                    className='bg-primary h-full transition-all'
                    style={{
                      width: `${progress.total ? Math.min(100, (progress.loaded / progress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
                <div className='text-end'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => abortRef.current?.abort()}
                  >
                    取消上传
                  </Button>
                </div>
              </div>
            )}

            <div className='flex items-center gap-3'>
              <Button
                disabled={
                  !file ||
                  uploading ||
                  !/^\d+\.\d+\.\d+$/.test(displayVersion.trim())
                }
                onClick={() => void startUpload()}
              >
                <Upload />
                发布新版本
              </Button>
              <p className='text-muted-foreground text-xs'>
                发布后学生端下次启动 raptor
                时提示更新；版本号需大于当前分发版本才会触发更新。
              </p>
            </div>
          </CardContent>
        </Card>

        {/* 历史版本 */}
        <Card className='mt-4'>
          <CardHeader className='flex-row items-start justify-between'>
            <div className='space-y-1.5'>
              <CardTitle>历史版本</CardTitle>
              <CardDescription>
                {isLoading && <Skeleton className='h-4 w-40' />}
                {updOverview?.unavailable
                  ? '更新后台不可用'
                  : updOverview?.data?.stats
                    ? `共 ${updOverview.data.stats.versionCount} 个版本 · 占用 ${fmtBytes(updOverview.data.stats.diskBytes)}`
                    : ''}
              </CardDescription>
            </div>
            <div className='text-muted-foreground text-xs'>
              {updOverview?.data?.current ? (
                <span>
                  当前分发{' '}
                  <code className='text-foreground font-mono font-semibold'>
                    v{updOverview.data.current.version}
                  </code>{' '}
                  · {fmtDateTime(updOverview.data.current.publishedAt)}
                </span>
              ) : (
                '尚未发布过版本'
              )}
            </div>
          </CardHeader>
          <CardContent>
            {updOverview?.unavailable && (
              <Alert variant='destructive'>
                <AlertTitle>更新后台未接入</AlertTitle>
                <AlertDescription>
                  {updOverview.error}。可重试；发布与密钥功能都依赖它。
                </AlertDescription>
              </Alert>
            )}
            {updOverview && !updOverview.unavailable && (
              <div className='space-y-2'>
                {(updVersions?.data?.versions ?? []).length === 0 && (
                  <p className='text-muted-foreground py-6 text-center text-sm'>
                    还没有发布过版本
                  </p>
                )}
                {(updVersions?.data?.versions ?? []).map((v) => (
                  <div
                    key={v.version}
                    className='flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2.5 text-sm'
                  >
                    <code className='font-mono font-semibold'>
                      v{v.version}
                    </code>
                    {v.isCurrent ? (
                      <Badge>分发中</Badge>
                    ) : v.rolledBackAt ? (
                      <Badge variant='secondary'>已回滚</Badge>
                    ) : null}
                    <span className='text-muted-foreground min-w-0 flex-1 truncate text-xs'>
                      {v.notes || '（无说明）'}
                    </span>
                    <span className='text-muted-foreground shrink-0 text-xs'>
                      {fmtDateTime(v.publishedAt)} · {fmtBytes(v.sizeBytes)}
                    </span>
                    {!v.isCurrent && (
                      <span className='flex shrink-0 gap-1'>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={rollback.isPending}
                          onClick={() => setConfirmRollback(v.version)}
                        >
                          <RotateCcw />
                          设为分发
                        </Button>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='text-destructive'
                          disabled={remove.isPending}
                          onClick={() => setConfirmDelete(v.version)}
                        >
                          <Trash2 />
                          删除
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <ConfirmDialog
          open={confirmRollback !== null}
          onOpenChange={(v) => !v && setConfirmRollback(null)}
          title='回滚分发版本'
          desc={`把 v${confirmRollback} 设为当前分发？学生端会收到「更新到此版本」的提示。`}
          cancelBtnText='取消'
          confirmText='设为分发'
          isLoading={rollback.isPending}
          handleConfirm={() => rollback.mutate()}
          className='sm:max-w-sm'
        />
        <ConfirmDialog
          open={confirmDelete !== null}
          onOpenChange={(v) => !v && setConfirmDelete(null)}
          title='删除版本'
          desc={`确定删除 v${confirmDelete} 的安装包吗？不可恢复（当前分发版本不可删）。`}
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
