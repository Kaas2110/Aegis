import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable } from 'drizzle-orm/pg-core';
import type { OdBudgetState } from '../opendotaBudget';

// Lazily initialized by the transport under an advisory lock. Keeping it in
// Drizzle's schema also prevents a later schema push from treating it as stray.
export const openDotaRequestBudgetTable = pgTable('opendota_request_budget', {
  id: integer('id').primaryKey(),
  state: jsonb('state').$type<OdBudgetState>().notNull(),
}, table => [check('opendota_request_budget_id_check', sql`${table.id} = 1`)]);
