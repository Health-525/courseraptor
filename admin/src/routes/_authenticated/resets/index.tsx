import { createFileRoute } from '@tanstack/react-router'
import { ResetsPage } from '@/features/resets'

export const Route = createFileRoute('/_authenticated/resets/')({
  component: ResetsPage,
})
