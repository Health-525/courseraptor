import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Clock,
  HardDrive,
  Layers,
  PackageOpen,
  RefreshCcw,
  Server,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatBytes, formatTime, formatTimePrecise, formatUptime } from '@/lib/format'
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
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'

function StatCard({
  title,
  value,
  caption,
  icon,
}: {
  title: string
  value: React.ReactNode
  caption: React.ReactNode
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm font-medium'>{title}</CardTitle>
        <span className='text-muted-foreground'>{icon}</span>
      </CardHeader>
      <CardContent>
        <div className='text-2xl font-bold tabular-nums'>{value}</div>
        <p className='mt-1 text-xs text-muted-foreground'>{caption}</p>
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  const { data, isPending, isError, refetch, isRefetching } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
  })

  const stats = data?.stats

  return (
    <Main>
      <PageHeader
        title='概览'
        description='服务器运行状态与学生端当前分发的版本'
        actions={
          <Button
            variant='outline'
            size='sm'
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCcw className='me-1 size-4' />
            刷新
          </Button>
        }
      />

      {isPending ? (
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className='h-32 rounded-xl' />
          ))}
        </div>
      ) : isError || !stats ? (
        <Alert variant='destructive'>
          <Server className='size-4' aria-hidden />
          <AlertTitle>无法加载概览数据</AlertTitle>
          <AlertDescription>
            服务器可能暂不可达，请稍后重试。
          </AlertDescription>
          <div className='mt-3'>
            <Button variant='outline' size='sm' onClick={() => refetch()}>
              <RefreshCcw className='me-1 size-4' />
              重试
            </Button>
          </div>
        </Alert>
      ) : (
        <>
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <StatCard
              title='当前版本'
              value={
                data.current ? (
                  <span className='font-mono'>v{data.current.version}</span>
                ) : (
                  '—'
                )
              }
              caption={
                data.current
                  ? formatTime(data.current.publishedAt)
                  : '尚未发布过版本'
              }
              icon={<Layers className='size-4' />}
            />
            <StatCard
              title='历史版本'
              value={stats.versionCount}
              caption='服务器保留的安装包'
              icon={<PackageOpen className='size-4' />}
            />
            <StatCard
              title='磁盘占用'
              value={formatBytes(stats.diskBytes)}
              caption={<span title={stats.dataDir}>安装包目录占用</span>}
              icon={<HardDrive className='size-4' />}
            />
            <StatCard
              title='运行时长'
              value={formatUptime(stats.uptimeSec)}
              caption={`Node ${stats.nodeVersion}`}
              icon={<Clock className='size-4' />}
            />
          </div>

          <Card className='mt-4'>
            <CardHeader>
              <div className='flex items-center gap-2'>
                <CardTitle>当前分发版本</CardTitle>
                {data.current && (
                  <span className='relative flex size-2' aria-hidden>
                    <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none' />
                    <span className='relative inline-flex size-2 rounded-full bg-primary' />
                  </span>
                )}
              </div>
              <CardDescription>
                学生端启动检查与 /update 命令下载到的版本
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.current ? (
                <>
                  <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
                    <span className='font-mono text-3xl font-semibold tracking-tight'>
                      v{data.current.version}
                    </span>
                    <Badge variant='secondary'>
                      发布于 {formatTimePrecise(data.current.publishedAt)}
                    </Badge>
                  </div>
                  <Separator className='my-4' />
                  <dl className='grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3'>
                    <div className='grid grid-cols-[4.5rem_1fr] items-baseline gap-2'>
                      <dt className='text-muted-foreground'>更新说明</dt>
                      <dd className='whitespace-pre-line'>
                        {data.current.notes || '（无）'}
                      </dd>
                    </div>
                    <div className='grid grid-cols-[4.5rem_1fr] items-baseline gap-2'>
                      <dt className='text-muted-foreground'>运行环境</dt>
                      <dd>Node {stats.nodeVersion}</dd>
                    </div>
                    <div className='grid grid-cols-[4.5rem_1fr] items-baseline gap-2'>
                      <dt className='text-muted-foreground'>数据目录</dt>
                      <dd className='truncate font-mono text-xs' title={stats.dataDir}>
                        {stats.dataDir}
                      </dd>
                    </div>
                  </dl>
                  <Button asChild variant='ghost' size='sm' className='mt-4 -ms-2'>
                    <Link to='/versions'>
                      查看历史版本
                      <ArrowRight className='ms-1 size-4' />
                    </Link>
                  </Button>
                </>
              ) : (
                <EmptyState
                  icon={<PackageOpen className='size-6' />}
                  title='还没有发布过版本'
                  description='上传第一个安装包后，学生端即可收到更新提示'
                  action={
                    <Button asChild>
                      <Link to='/publish'>
                        <ArrowRight className='me-1 size-4' />
                        发布第一个版本
                      </Link>
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </Main>
  )
}
