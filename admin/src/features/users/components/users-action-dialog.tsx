'use client'

import { useEffect } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { userAction, userCreate } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'
import { type User } from '../data/schema'

/**
 * 双形态（沿用模板形态）：无 currentRow = 新增用户（用户名+初始密码）；
 * 有 currentRow = 设每日限额。动作走 /admin/api/user/*，成功后刷新 bootstrap。
 */
const formSchema = z
  .object({
    username: z
      .string()
      .regex(/^[A-Za-z0-9_-]{2,32}$/, '字母 / 数字 / _ / -，2-32 位'),
    password: z.string(),
    turns: z.string(),
    isEdit: z.boolean(),
  })
  .refine(({ isEdit, password }) => isEdit || password.length >= 8, {
    message: '初始密码至少 8 位',
    path: ['password'],
  })

type UserForm = z.infer<typeof formSchema>

type UserActionDialogProps = {
  currentRow?: User
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UsersActionDialog({
  currentRow,
  open,
  onOpenChange,
}: UserActionDialogProps) {
  const isEdit = !!currentRow
  const { data } = useBootstrap()
  const invalidate = useInvalidateBootstrap()
  const siteDefault = data?.site.defaultDailyTurns ?? 0

  const form = useForm<UserForm>({
    resolver: zodResolver(formSchema),
    defaultValues: isEdit
      ? {
          username: currentRow.username,
          password: '',
          turns: String(currentRow.dailyTurns),
          isEdit,
        }
      : { username: '', password: '', turns: '0', isEdit },
  })

  // 编辑态每次打开重置为该用户当前值
  useEffect(() => {
    if (open && currentRow) {
      form.reset({
        username: currentRow.username,
        password: '',
        turns: String(currentRow.dailyTurns),
        isEdit: true,
      })
    }
  }, [open, currentRow, form])

  const save = useMutation({
    mutationFn: (values: UserForm) =>
      isEdit && currentRow
        ? userAction('quota', currentRow.id, {
            turns: Number(values.turns) || 0,
          })
        : userCreate(values.username.trim(), values.password),
    onSuccess: (_res, values) => {
      toast.success(
        isEdit && currentRow
          ? `${currentRow.username} 每日限额已更新`
          : `已创建 ${values.username.trim()}，账号建好即可登录`
      )
      form.reset()
      onOpenChange(false)
      void invalidate()
    },
  })

  const onSubmit = (values: UserForm) => save.mutate(values)

  return (
    <Dialog
      open={open}
      onOpenChange={(state) => {
        form.reset()
        onOpenChange(state)
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader className='text-start'>
          <DialogTitle>
            {isEdit ? `设每日限额 · ${currentRow?.username}` : '新增用户'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? '只限制用站点 Key 的轮数；同学用自己的 Key 不受限。'
              : '不走邀请码直接建号；账号建好即可登录，同学登录后可自行改密码。'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id='user-form'
            onSubmit={form.handleSubmit(onSubmit)}
            className='space-y-4 px-0.5'
          >
            {!isEdit && (
              <>
                <FormField
                  control={form.control}
                  name='username'
                  render={({ field }) => (
                    <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                      <FormLabel className='col-span-2 text-end'>
                        用户名
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder='字母 / 数字 / _ / -'
                          className='col-span-4'
                          autoComplete='off'
                          {...field}
                        />
                      </FormControl>
                      <FormMessage className='col-span-4 col-start-3' />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='password'
                  render={({ field }) => (
                    <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                      <FormLabel className='col-span-2 text-end'>
                        初始密码
                      </FormLabel>
                      <FormControl>
                        <PasswordInput
                          placeholder='至少 8 位，同学可自行修改'
                          className='col-span-4'
                          autoComplete='new-password'
                          {...field}
                        />
                      </FormControl>
                      <FormMessage className='col-span-4 col-start-3' />
                    </FormItem>
                  )}
                />
              </>
            )}
            {isEdit && (
              <FormField
                control={form.control}
                name='turns'
                render={({ field }) => (
                  <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                    <FormLabel className='col-span-2 text-end'>
                      每日限额
                    </FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        min={0}
                        max={100000}
                        placeholder='0'
                        className='col-span-4'
                        {...field}
                      />
                    </FormControl>
                    <FormDescription className='text-muted-foreground col-span-4 col-start-3'>
                      站点默认 {siteDefault} 轮/人/日；填 0 表示跟随站点默认。
                    </FormDescription>
                    <FormMessage className='col-span-4 col-start-3' />
                  </FormItem>
                )}
              />
            )}
          </form>
        </Form>
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type='submit' form='user-form' disabled={save.isPending}>
            {save.isPending ? '处理中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
