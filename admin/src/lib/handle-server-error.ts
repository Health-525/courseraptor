import { AxiosError } from 'axios'
import { toast } from 'sonner'

/** 统一的接口错误提示：优先用后端返回的中文 error 文案 */
export function handleServerError(error: unknown) {
  // eslint-disable-next-line no-console
  console.log(error)

  let errMsg = '操作失败，请稍后重试'

  if (error instanceof AxiosError) {
    errMsg = (error.response?.data as { error?: string } | undefined)?.error ?? errMsg
    if (error.code === 'ERR_NETWORK') errMsg = '网络异常，无法连接服务器'
  }

  toast.error(errMsg)
}
