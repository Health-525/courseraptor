export function ownDeepseekKeyActive(
  usersDir: string,
  userId: string,
  providerId?: string,
): Promise<boolean>;

/** 实际生效供应商：同学自选（users.json）> 站点默认（site.json）> deepseek */
export function effectiveProviderIdFor(
  registry: { getSiteSettings(): Promise<{ defaultProvider?: string }> },
  user: { providerId?: string } | null | undefined,
): Promise<string>;
