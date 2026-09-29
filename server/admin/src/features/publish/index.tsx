import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  FileArchive,
  Info,
  UploadCloud,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, publishWithProgress } from '@/lib/api'
import { formatBytes, formatTime } from '@/lib/format'
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
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'

const SEMVER_RE = /^\d+\.\d+\.\d+$/
const MAX_FILE_BYTES = 200 * 1024 * 1024

function nextPatchVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number)
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return ''
  return `${major}.${minor}.${patch + 1}`
}

function FileDropzone({
  file,
  onSelect,
  onClear,
  disabled,
}: {
  file: File | null
  onSelect: (file: File) => void
  onClear: () => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)

  function accept(list: FileList | null) {
    const picked = list?.[0]
    if (!picked) return
    if (!picked.name.toLowerCase().endsWith('.zip')) {
      toast.error('只支持 zip 格式的安装包')
      return
    }
    if (picked.size > MAX_FILE_BYTES) {
      toast.error(`安装包超过 200 MB 上限（当前 ${formatBytes(picked.size)}）`)
      return
    }
    onSelect(picked)
  }

  if (file) {
    return (
      <div className='flex items-center gap-3 rounded-lg border bg-muted/40 p-3'>
        <span className='flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary'>
          <FileArchive className='size-5' aria-hidden />
        </span>
        <div className='min-w-0 flex-1'>
          <p className='truncate text-sm font-medium'>{file.name}</p>
          <p className='text-xs text-muted-foreground'>{formatBytes(file.size)}</p>
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='size-8 shrink-0'
          onClick={onClear}
          disabled={disabled}
          aria-label='移除已选文件'
        >
          <X className='size-4' />
        </Button>
      </div>
    )
  }

  return (
    <div
      role='button'
      tabIndex={0}
      aria-label='选择或拖入 zip 安装包'
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragActive(false)
        accept(e.dataTransfer.files)
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors',
        'hover:border-primary/50 hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
        dragActive ? 'border-primary bg-primary/[0.06]' : 'border-border',
        disabled && 'pointer-events-none opacity-60'
      )}
    >
      <input
        ref={inputRef}
        type='file'
        accept='.zip,application/zip'
        className='hidden'
        onChange={(e) => {
          accept(e.target.files)
          e.target.value = ''
        }}
        tabIndex={-1}
      />
      <span className='flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary'>
        <UploadCloud className='size-6' aria-hidden />
      </span>
      <div className='space-y-1'>
        <p className='text-sm font-medium'>点击选择，或拖入 zip 安装包</p>
        <p className='text-xs text-muted-foreground'>最大 200 MB</p>
      </div>
    </div>
  )
}

export function Publish() {
  const queryClient = useQueryClient()
  const { data: overview } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
  })
  // version 为 null 表示用户未编辑，展示自动预填的下一版本号
  const [version, setVersion] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const suggested = overview?.current ? nextPatchVersion(overview.current.version) : ''
  const currentVersion = overview?.current?.version ?? null

  const finalVersion = version ?? suggested
  const versionInvalid = finalVersion !== '' && !SEMVER_RE.test(finalVersion)
  const sameAsCurrent = Boolean(
    currentVersion && SEMVER_RE.test(finalVersion) && finalVersion === currentVersion
  )
  const canSubmit =
    Boolean(file) && SEMVER_RE.test(finalVersion) && progress === null

  function cancelUpload() {
    abortRef.current?.abort()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setProgress(0)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await publishWithProgress(file!, finalVersion, notes.trim(), setProgress, controller.signal)
      toast.success(`v${finalVersion} 已发布`, {
        description: '学生端下次启动 raptor 即会提示更新',
      })
      setNotes('')
      setFile(null)
      setVersion(null)
      await queryClient.invalidateQueries()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        toast.info('已取消上传')
      } else {
        toast.error(err instanceof Error ? err.message : '发布失败')
      }
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  return (
    <Main>
      <PageHeader
        title='发布新版本'
        description='上传新的 zip 安装包，学生端启动 raptor 时会收到更新提示'
      />

      <div className='grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]'>
        <Card className='max-w-2xl xl:max-w-none'>
          <CardHeader>
            <CardTitle>上传安装包</CardTitle>
            <CardDescription>
              打包好的 zip 上传后立即对学生端生效
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className='grid gap-5'>
              <div className='grid gap-2'>
                <Label htmlFor='version'>版本号</Label>
                <Input
                  id='version'
                  value={finalVersion}
                  onChange={(e) => setVersion(e.target.value.trim())}
                  placeholder='x.y.z'
                  inputMode='numeric'
                  className='font-mono'
                  aria-invalid={versionInvalid || undefined}
                />
                {versionInvalid ? (
                  <p className='flex items-center gap-1 text-xs text-destructive'>
                    <CircleAlert className='size-3.5' aria-hidden />
                    版本号必须是 x.y.z 格式，例如 1.2.3
                  </p>
                ) : sameAsCurrent ? (
                  <p className='flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400'>
                    <CircleAlert className='size-3.5' aria-hidden />
                    与当前分发版本相同，学生端不会提示更新
                  </p>
                ) : (
                  <p className='text-xs text-muted-foreground'>
                    {currentVersion
                      ? `当前分发 v${currentVersion}${suggested ? `，已预填下一 patch 版本` : ''}`
                      : '尚未发布过版本，这将是第一个版本'}
                  </p>
                )}
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='zip'>安装包</Label>
                <FileDropzone
                  file={file}
                  onSelect={setFile}
                  onClear={() => setFile(null)}
                  disabled={progress !== null}
                />
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='notes'>更新说明（可选）</Label>
                <Textarea
                  id='notes'
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder='例如：修复课表周次显示错误'
                />
                <p className='text-xs text-muted-foreground'>
                  学生端更新提示中展示，最多 2000 字
                </p>
              </div>

              {progress !== null && (
                <div className='grid gap-2 rounded-lg border bg-muted/30 p-3'>
                  <div className='flex items-center justify-between text-xs text-muted-foreground'>
                    <span>{progress === 100 ? '服务器处理中…' : '上传中'}</span>
                    <span className='font-mono tabular-nums'>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                  <div className='flex justify-end'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={cancelUpload}
                    >
                      取消上传
                    </Button>
                  </div>
                </div>
              )}

              <Button type='submit' disabled={!canSubmit}>
                {progress !== null ? '发布中…' : '发布'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className='grid gap-6'>
          <Card>
            <CardHeader>
              <CardTitle>当前分发版本</CardTitle>
              <CardDescription>发布成功后此处立即切换</CardDescription>
            </CardHeader>
            <CardContent>
              {overview?.current ? (
                <div className='space-y-2'>
                  <p className='font-mono text-xl font-semibold'>
                    v{overview.current.version}
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    发布于 {formatTime(overview.current.publishedAt)}
                  </p>
                  {overview.current.notes && (
                    <p className='border-s-2 ps-2 text-sm text-muted-foreground'>
                      {overview.current.notes}
                    </p>
                  )}
                </div>
              ) : (
                <p className='text-sm text-muted-foreground'>尚未发布过版本</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>发布须知</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className='grid gap-3 text-sm text-muted-foreground'>
                {[
                  '安装包为 zip 格式，单个不超过 200 MB',
                  '版本号应大于当前版本，否则学生端不会提示更新',
                  '发布后学生端启动 raptor 时提示更新',
                  '命令行 npm run publish 与本页共用同一接口',
                ].map((item) => (
                  <li key={item} className='flex gap-2'>
                    <CircleCheck
                      className='mt-0.5 size-4 shrink-0 text-primary'
                      aria-hidden
                    />
                    {item}
                  </li>
                ))}
              </ul>
              <p className='mt-4 flex gap-2 text-xs text-muted-foreground'>
                <Info className='mt-0.5 size-3.5 shrink-0' aria-hidden />
                上传完成后可前往「历史版本」回滚或删除
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </Main>
  )
}
