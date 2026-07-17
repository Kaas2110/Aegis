/**
 * Пользователи мобилки. Простая email+password аутентификация
 * (Apple/Google sign-in недоступны в текущей среде).
 *
 * Пароли хранятся как scrypt(password, salt) в формате `${saltHex}$${hashHex}`.
 * Сессии stateless — HMAC-токен с user_id+exp подписан SESSION_SECRET, поэтому
 * отдельная таблица сессий не нужна.
 */
import { pgTable, text, timestamp, serial, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const usersTable = pgTable(
  'app_users',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Тариф пользователя: 'free' | 'basic' | 'premium'. Пока все 'free'. */
    tariff: text('tariff').notNull().default('free'),
    /** Промокод источника (ref_codes.code), указанный при регистрации. */
    refCode: text('ref_code'),
  },
  (t) => [
    // Email уникален case-insensitive. На уровне БД enforce'им через unique
    // index по lower(email) — защищает от race-condition между двумя
    // одновременными registration'ами.
    uniqueIndex('app_users_email_unique_lower').on(sql`lower(${t.email})`),
  ],
);

export type AppUser = typeof usersTable.$inferSelect;
export type NewAppUser = typeof usersTable.$inferInsert;
