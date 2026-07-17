/**
 * Реферальная система («Источники» в админке).
 *
 * ref_codes  — источники трафика: код, метка, вкл/выкл. Ссылка вида
 *              https://<host>/r/<code> редиректит на лендинг/стор и логирует клик.
 * ref_clicks — лог кликов по реферальной ссылке (по коду, не FK — код может
 *              быть удалён, клики остаются для истории).
 *
 * Привязка пользователя к источнику — через app_users.ref_code (промокод при
 * регистрации в мобилке; поле включается/выключается через client-config).
 */
import { pgTable, text, timestamp, serial, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const refCodesTable = pgTable(
  'ref_codes',
  {
    id: serial('id').primaryKey(),
    /** Короткий код (латиница/цифры/дефис), уникален case-insensitive. */
    code: text('code').notNull(),
    /** Человекочитаемая метка источника («Telegram-канал X», «YouTube Y»). */
    label: text('label').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('ref_codes_code_unique_lower').on(sql`lower(${t.code})`)],
);

export const refClicksTable = pgTable(
  'ref_clicks',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    clickedAt: timestamp('clicked_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('ref_clicks_code_idx').on(t.code)],
);

export type RefCode = typeof refCodesTable.$inferSelect;
export type NewRefCode = typeof refCodesTable.$inferInsert;
export type RefClick = typeof refClicksTable.$inferSelect;
