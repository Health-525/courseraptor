/**
 * 面板数据查询：bootstrap 单请求模式（与旧管理台一致），
 * 60 秒轮询（TanStack Query 默认仅在窗口可见时触发），变更后失效重取。
 */
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchBootstrap, type Bootstrap } from '@/lib/api'

export const bootstrapKey = ['bootstrap'] as const

export const bootstrapQueryOptions = queryOptions({
  queryKey: bootstrapKey,
  queryFn: fetchBootstrap,
  refetchInterval: 60_000,
  staleTime: 10_000,
})

export function useBootstrap() {
  return useQuery(bootstrapQueryOptions)
}

/** 变更成功后统一刷新全部面板数据 */
export function useInvalidateBootstrap() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: bootstrapKey })
}

export type BootstrapData = Bootstrap
