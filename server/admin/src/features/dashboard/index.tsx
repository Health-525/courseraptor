import { format } from 'date-fns'
import {
  Clock,
  Database,
  HardDrive,
  Layers,
  RefreshCcw,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`
  return `${Math.floor(seconds / 86400)} 天`
}

export function Dashboard() {
  const { data, isPending, refetch, isRefetching } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
  })

  const stats = data?.stats

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
          <h1 className='text-2xl font-bold tracking-tight'>概览</h1>
          <Button
            variant='outline'
            size='sm'
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCcw className='me-1 size-4' />
            刷新
          </Button>
        </div>

        {isPending ? (
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className='h-32 rounded-xl' />
            ))}
          </div>
        ) : stats ? (
          <>
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>当前版本</CardTitle>
                  <Layers className='size-4 text-muted-foreground' />
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>
                    {data.current ? `v${data.current.version}` : '—'}
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    {data.current
                      ? format(new Date(data.current.publishedAt), 'yyyy-MM-dd HH:mm')
                      : '尚未发布过版本'}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>历史版本</CardTitle>
                  <Clock className='size-4 text-muted-foreground' />
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>{stats.versionCount}</div>
                  <p className='text-xs text-muted-foreground'>服务器保留的安装包</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>磁盘占用</CardTitle>
                  <HardDrive className='size-4 text-muted-foreground' />
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>
                    {formatBytes(stats.diskBytes)}
                  </div>
                  <p className='text-xs text-muted-foreground'>update-data 目录</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>运行时长</CardTitle>
                  <Database className='size-4 text-muted-foreground' />
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>
                    {formatUptime(stats.uptimeSec)}
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    Node {stats.nodeVersion}
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card className='mt-4'>
              <CardHeader>
                <CardTitle>当前分发版本</CardTitle>
                <CardDescription>
                  学生端启动检查与 /update 命令下载到的版本
                </CardDescription>
              </CardHeader>
              <CardContent className='grid gap-1 text-sm'>
                {data.current ? (
                  <>
                    <div>
                      版本：<span className='font-mono font-semibold'>v{data.current.version}</span>
                    </div>
                    <div>发布时间：{format(new Date(data.current.publishedAt), 'yyyy-MM-dd HH:mm:ss')}</div>
                    <div className='text-muted-foreground'>
                      更新说明：{data.current.notes || '（无）'}
                    </div>
                  </>
                ) : (
                  <p className='text-muted-foreground'>
                    还没有发布过版本，前往「发布新版本」上传第一个安装包。
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </Main>
    </>
  )
}
