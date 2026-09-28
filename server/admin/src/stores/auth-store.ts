import { create } from 'zustand'
import { getCookie, setCookie, removeCookie } from '@/lib/cookies'

// 管理员密钥即身份：服务端用 UPDATE_ADMIN_TOKEN 校验 x-admin-token 头。
const ADMIN_TOKEN = 'raptor-admin-token'

interface AuthState {
  auth: {
    accessToken: string
    setAccessToken: (accessToken: string) => void
    reset: () => void
  }
}

export const useAuthStore = create<AuthState>()((set) => {
  const initToken = getCookie(ADMIN_TOKEN) ?? ''
  return {
    auth: {
      accessToken: initToken,
      setAccessToken: (accessToken) =>
        set((state) => {
          setCookie(ADMIN_TOKEN, accessToken)
          return { ...state, auth: { ...state.auth, accessToken } }
        }),
      reset: () =>
        set((state) => {
          removeCookie(ADMIN_TOKEN)
          return { ...state, auth: { ...state.auth, accessToken: '' } }
        }),
    },
  }
})
