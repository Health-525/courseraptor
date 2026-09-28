type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='container grid h-svh max-w-none items-center justify-center'>
      <div className='mx-auto flex w-full flex-col justify-center space-y-2 py-8 sm:p-8'>
        <div className='mb-4 flex items-center justify-center'>
          <span className='me-2 text-3xl' aria-hidden>
            🦖
          </span>
          <h1 className='text-xl font-medium'>CourseRaptor Admin</h1>
        </div>
        {children}
      </div>
    </div>
  )
}
