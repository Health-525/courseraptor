import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Users } from '@/features/users'

const usersSearchSchema = z.object({
  page: z.number().optional().catch(1),
  pageSize: z.number().optional().catch(10),
  // Facet filters
  status: z
    .array(
      z.union([z.literal('active'), z.literal('online'), z.literal('disabled')])
    )
    .optional()
    .catch([]),
  keySource: z
    .array(z.union([z.literal('site'), z.literal('own')]))
    .optional()
    .catch([]),
  // Per-column text filter
  username: z.string().optional().catch(''),
})

export const Route = createFileRoute('/_authenticated/users/')({
  validateSearch: usersSearchSchema,
  component: Users,
})
