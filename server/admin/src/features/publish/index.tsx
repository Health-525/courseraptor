import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, publishWithProgress } from '@/lib/api'
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
import { Textarea } from '@/components/ui/textarea'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

const SEMVER_RE = /^\d+\.\d+\.\d+$/

function nextPatchVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number)
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return ''
  return `${major}.${minor}.${patch + 1}`
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const suggested = overview?.current ? nextPatchVersion(overview.current.version) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const finalVersion = version ?? suggested
    if (!SEMVER_RE.test(finalVersion)) {
      toast.error('版本号必须是 x.y.z 格式')
      return
    }
    if (!file) {
      toast.error('请选择要发布的 zip 安装包')
      return
    }
    setProgress(0)
    try {
      await publishWithProgress(file, finalVersion, notes.trim(), setProgress)
      toast.success(`v${finalVersion} 已发布`, {
        description: '学生端下次启动 raptor 即会提示更新',
      })
      setNotes('')
      setFile(null)
      setVersion(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发布失败')
    } finally {
      setProgress(null)
    }
  }

  return (
    <>
      <Header>
        <div className='me-auto' />
        <Search placeholder='搜索功能' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main>
        <div className='mb-2 flex items-center justify-between space-y-2'>
          <h1 className='text-2xl font-bold tracking-tight'>发布新版本</h1>
        </div>

        <Card className='max-w-2xl'>
          <CardHeader>
            <CardTitle>上传安装包</CardTitle>
            <CardDescription>
              选择打包好的 zip 上传，学生端启动时即会提示更新；
              命令行发版（npm run publish）与本页共用同一接口。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className='grid gap-5'>
              <div className='grid gap-2'>
                <Label htmlFor='version'>版本号</Label>
                <Input
                  id='version'
                  value={version ?? suggested}
                  onChange={(e) => setVersion(e.target.value.trim())}
                  placeholder='x.y.z'
                  inputMode='numeric'
                />
                <p className='text-xs text-muted-foreground'>
                  {overview?.current
                    ? `当前分发版本 v${overview.current.version}，已预填下一 patch 版本`
                    : '尚未发布过版本'}
                </p>
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='zip'>安装包（zip，最大 200 MB）</Label>
                <Input
                  id='zip'
                  ref={fileInputRef}
                  type='file'
                  accept='.zip,application/zip'
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
                <div className='grid gap-1'>
                  <div className='h-2 w-full overflow-hidden rounded-full bg-muted'><div className='h-full rounded-full bg-primary transition-all' style={{ width: `${progress}%` }} /></div>
                  <p className='text-xs text-muted-foreground'>
                    {progress === 100 ? '处理中…' : `上传中 ${progress}%`}
                  </p>
                </div>
              )}

              <Button type='submit' disabled={progress !== null}>
                {progress !== null ? '上传中…' : '发布'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
