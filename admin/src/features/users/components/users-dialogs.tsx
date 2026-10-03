import { UserConfirmDialog } from './user-confirm-dialog'
import { UsersActionDialog } from './users-action-dialog'
import { UsersDeleteDialog } from './users-delete-dialog'
import { useUsers } from './users-provider'

export function UsersDialogs() {
  const { open, setOpen, currentRow, setCurrentRow } = useUsers()

  const closeRowDialog = () => {
    setOpen(null)
    setTimeout(() => {
      setCurrentRow(null)
    }, 500)
  }

  return (
    <>
      <UsersActionDialog
        key='user-add'
        open={open === 'add'}
        onOpenChange={() => setOpen('add')}
      />

      {currentRow && (
        <>
          <UsersActionDialog
            key={`user-edit-${currentRow.id}`}
            open={open === 'edit'}
            onOpenChange={closeRowDialog}
            currentRow={currentRow}
          />

          <UsersDeleteDialog
            key={`user-delete-${currentRow.id}`}
            open={open === 'delete'}
            onOpenChange={closeRowDialog}
            currentRow={currentRow}
          />

          <UserConfirmDialog
            key={`user-confirm-${currentRow.id}-${open}`}
            open={open === 'disable' || open === 'enable' || open === 'kick'}
            onOpenChange={closeRowDialog}
            currentRow={currentRow}
            action={
              open === 'disable' || open === 'enable' || open === 'kick'
                ? open
                : null
            }
          />
        </>
      )}
    </>
  )
}
