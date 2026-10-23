import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable } from 'drizzle-orm/pg-core';
import type { StratzBudgetState } from '../stratzBudget';

export const stratzRequestBudgetTable = pgTable('stratz_request_budget', {
  id: integer('id').primaryKey(),
  state: jsonb('state').$type<StratzBudgetState>().notNull(),
}, table => [check('stratz_request_budget_id_check', sql`${table.id} = 1`)]);
