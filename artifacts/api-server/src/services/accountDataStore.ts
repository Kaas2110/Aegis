import type { AccountDataStore, AccountRecord } from './accountData';
import { verifyPassword } from './userCredentials';

// Structural pg interface keeps fixtures independent from the real application DB.
interface QueryResult { rows: Record<string, unknown>[]; rowCount: number | null }
interface AccountConnection {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
interface AccountPool { connect(): Promise<AccountConnection> }

function accountFromRow(row: Record<string, unknown>): AccountRecord {
  return {
    id: Number(row.id), email: String(row.email), passwordHash: String(row.password_hash),
    createdAt: row.created_at as Date, lastLoginAt: row.last_login_at as Date | null,
    tariff: String(row.tariff), refCode: row.ref_code === null ? null : String(row.ref_code),
  };
}

const ACCOUNT_COLUMNS = 'id, email, password_hash, created_at, last_login_at, tariff, ref_code';

export function createAccountDataStore(pool: AccountPool): AccountDataStore {
  return {
    async read(userId) {
      const client = await pool.connect();
      try {
        const result = await client.query(`SELECT ${ACCOUNT_COLUMNS} FROM app_users WHERE id = $1`, [userId]);
        return result.rows[0] ? accountFromRow(result.rows[0]) : null;
      } finally { client.release(); }
    },
    async deleteWithPassword(userId, password) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        const result = await client.query('SELECT password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
        const row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return 'already_deleted';
        }
        if (!verifyPassword(password, String(row.password_hash))) {
          await client.query('ROLLBACK');
          return 'invalid_password';
        }
        // No user-owned FK tables exist in the current schema. Do not delete
        // referral campaigns/clicks or shared match/model data by association.
        const removed = await client.query('DELETE FROM app_users WHERE id = $1', [userId]);
        if (removed.rowCount !== 1) throw new Error('account_delete_not_applied');
        await client.query('COMMIT');
        return 'deleted';
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally { client.release(); }
    },
  };
}
