import { toast } from 'sonner'
import { ApiError } from '@/lib/api'

export function handleServerError(error: unknown) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(error)
  }

  let errMsg = '操作失败，请稍后重试'

  if (error instanceof ApiError) {
    if (error.message) errMsg = error.message
  }

  toast.error(errMsg)
}
