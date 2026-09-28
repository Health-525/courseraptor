import { useAuthStore } from '@/stores/auth-store'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('x-admin-token', useAuthStore.getState().auth.accessToken)
  const res = await fetch(path, { ...init, headers })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 空响应体
  }
  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`
    throw new ApiError(res.status, message)
  }
  return data as T
}

export interface VersionMeta {
  version: string
  notes: string
  publishedAt: string
}

export interface Overview {
  current: VersionMeta | null
  stats: {
    versionCount: number
    diskBytes: number
    nodeVersion: string
    uptimeSec: number
    dataDir: string
  }
}

export interface VersionEntry extends VersionMeta {
  sizeBytes: number
  isCurrent: boolean
}

export const api = {
  overview: () => request<Overview>('/admin/api/overview'),
  versions: () => request<{ versions: VersionEntry[] }>('/admin/api/versions'),
  rollback: (version: string, notes?: string) =>
    request<{ ok: true }>('/admin/api/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, notes }),
    }),
  deleteVersion: (version: string) =>
    request<{ ok: true }>('/admin/api/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    }),
}

/** 上传发版走 XHR：fetch 拿不到上传进度。 */
export function publishWithProgress(
  zip: File,
  version: string,
  notes: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/publish')
    xhr.setRequestHeader('x-admin-token', useAuthStore.getState().auth.accessToken)
    xhr.setRequestHeader('x-version', version)
    xhr.setRequestHeader('x-notes', encodeURIComponent(notes))
    xhr.setRequestHeader('content-type', 'application/zip')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100)
        resolve()
        return
      }
      let message = `发布失败（HTTP ${xhr.status}）`
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        // 非 JSON 错误响应
      }
      reject(new ApiError(xhr.status, message))
    }
    xhr.onerror = () => reject(new ApiError(0, '网络错误，请检查服务器是否可达'))
    xhr.send(zip)
  })
}
