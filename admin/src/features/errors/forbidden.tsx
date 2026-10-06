import { useNavigate, useRouter } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

export function ForbiddenError() {
  const navigate = useNavigate()
  const { history } = useRouter()
  return (
    <div className='h-svh'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>403</h1>
        <span className='font-medium'>无权访问</span>
        <p className='text-center text-muted-foreground'>
          你没有查看此页面所需的权限
        </p>
        <div className='mt-6 flex gap-4'>
          <Button variant='outline' onClick={() => history.go(-1)}>
            返回上页
          </Button>
          <Button onClick={() => navigate({ to: '/' })}>回总览</Button>
        </div>
      </div>
    </div>
  )
}
