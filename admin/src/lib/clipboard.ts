import { toast } from 'sonner'

/** 复制到剪贴板并给出轻提示（非 https 环境降级为 execCommand） */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast.success('已复制')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}
