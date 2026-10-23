export interface AccountRecord {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: Date | string;
  lastLoginAt: Date | string | null;
  tariff: string;
  refCode: string | null;
}

export type DeleteAccountResult = 'deleted' | 'already_deleted' | 'invalid_password';
export interface AccountDataStore {
  read(userId: number): Promise<AccountRecord | null>;
  /** Must verify the password under the same row lock/transaction as deletion. */
  deleteWithPassword(userId: number, password: string): Promise<DeleteAccountResult>;
}

/** Explicit allowlist: new DB columns never silently enter an export. */
export function exportAccount(record: AccountRecord) {
  return {
    formatVersion: 1,
    scope: 'server_account',
    account: {
      id: record.id,
      email: record.email,
      createdAt: record.createdAt,
      lastLoginAt: record.lastLoginAt,
      tariff: record.tariff,
      referralCode: record.refCode,
    },
    limitations: ['device_local_data_not_included', 'operational_logs_and_backups_not_included'],
  };
}
