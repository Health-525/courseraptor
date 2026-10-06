export function MaintenanceError() {
  return (
    <div className='h-svh'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>503</h1>
        <span className='font-medium'>服务维护中</span>
        <p className='text-center text-muted-foreground'>
          服务暂时不可用，很快会恢复
        </p>
      </div>
    </div>
  )
}
