export function generateTotpSecret(): string;
export function base32Encode(buffer: Uint8Array): string;
export function base32Decode(text: string): Buffer;
export function verifyTotp(
  secretBase32: string,
  candidate: string,
  options?: { window?: number; now?: number; lastUsedCounter?: number },
): { ok: true; counter: number } | { ok: false; replay?: boolean };
export function otpauthUri(options: { secret: string; issuer?: string; account?: string }): string;
export function generateRecoveryCodes(count?: number): string[];
export function normalizeRecoveryCode(input: string): string;
export function hashRecoveryCode(input: string): string;
