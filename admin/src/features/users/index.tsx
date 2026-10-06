import { getRouteApi } from '@tanstack/react-router'
import { useBootstrap } from '@/lib/admin-data'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { UsersDialogs } from './components/users-dialogs'
import { UsersPrimaryButtons } from './components/users-primary-buttons'
import { UsersProvider } from './components/users-provider'
import { UsersTable } from './components/users-table'

const route = getRouteApi('/_authenticated/users/')

export function Users() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const { data, isLoading } = useBootstrap()
  const users = data?.users ?? []
  const onlineCount = users.filter((u) => u.online).length

  return (
    <UsersProvider>
      <AdminHeader title='同学账号' pretitle='ADMIN · 管理' />

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-wrap items-end justify-between gap-2'>
          <p className='text-muted-foreground'>
            共 {users.length} 个账号 · {onlineCount} 个在线
          </p>
          <UsersPrimaryButtons />
        </div>
        {isLoading ? null : (
          <UsersTable data={users} search={search} navigate={navigate} />
        )}
      </Main>

      <UsersDialogs />
    </UsersProvider>
  )
}
