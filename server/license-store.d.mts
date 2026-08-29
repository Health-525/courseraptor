export type LicenseStatus = "active" | "disabled";

export interface LicenseRecord {
  id: number;
  keyHint: string;
  status: LicenseStatus;
  note: string;
  expiresAt: string | null;
  createdAt: string;
  activatedAt: string | null;
  lastCheckAt: string | null;
  deviceBound: boolean;
}

export interface CreatedLicense extends LicenseRecord {
  /** 仅创建时返回一次，数据库和列表接口均不保存/返回明文。 */
  licenseKey: string;
}

export class LicenseStoreError extends Error {
  readonly code: string;
}

export interface LicenseStore {
  createLicense(input?: { note?: string; expiresAt?: string }): CreatedLicense;
  listLicenses(): LicenseRecord[];
  activate(input: { licenseKey: string; deviceId: string }): LicenseRecord;
  check(input: { licenseKey: string; deviceId: string }): LicenseRecord;
  disableLicense(id: number): LicenseRecord;
  enableLicense(id: number): LicenseRecord;
  resetDevice(id: number): LicenseRecord;
  close(): void;
}

export function createLicenseStore(options: {
  databasePath: string;
  secret: string;
  now?: () => Date;
}): LicenseStore;
