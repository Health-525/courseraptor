import { createFileRoute } from '@tanstack/react-router'
import { KeysPage } from '@/features/keys'

export const Route = createFileRoute('/_authenticated/keys/')({
  component: KeysPage,
})
