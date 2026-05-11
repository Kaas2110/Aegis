import { Router, type IRouter } from 'express';
import { db, teamsTable } from '@workspace/db';
import { desc, ilike, or, sql } from 'drizzle-orm';

const router: IRouter = Router();

/**
 * GET /api/teams/tier1?limit=50
 * Возвращает топ-команд по рейтингу Glicko из OpenDota.
 * Используется мобилкой для списка «любимых команд».
 */
router.get('/tier1', async (req, res) => {
  const rawLimit = Number(req.query['limit'] ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);

  const rows = await db
    .select({
      teamId: teamsTable.teamId,
      name: teamsTable.name,
      tag: teamsTable.tag,
      rating: teamsTable.rating,
      wins: teamsTable.wins,
      losses: teamsTable.losses,
    })
    .from(teamsTable)
    .where(sql`${teamsTable.rating} is not null and ${teamsTable.name} is not null`)
    .orderBy(desc(teamsTable.rating))
    .limit(limit);

  res.json({
    teams: rows.map((t) => ({
      ...t,
      logoUrl: `https://api.opendota.com/apps/dota2/images/team_logos/${t.teamId}.png`,
    })),
    count: rows.length,
  });
});

/**
 * GET /api/teams/search?q=team+name&limit=20
 * Поиск команд по имени или тэгу. Используется чтобы пользователь
 * мог добавить любую (даже не-tier1) команду в избранное.
 */
router.get('/search', async (req, res) => {
  const q = String(req.query['q'] ?? '').trim();
  if (q.length < 2) {
    res.json({ teams: [], count: 0 });
    return;
  }
  const rawLimit = Number(req.query['limit'] ?? 20);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);

  const pattern = `%${q}%`;
  const rows = await db
    .select({
      teamId: teamsTable.teamId,
      name: teamsTable.name,
      tag: teamsTable.tag,
      rating: teamsTable.rating,
    })
    .from(teamsTable)
    .where(or(ilike(teamsTable.name, pattern), ilike(teamsTable.tag, pattern)))
    .orderBy(desc(teamsTable.rating))
    .limit(limit);

  res.json({
    teams: rows.map((t) => ({
      ...t,
      logoUrl: `https://api.opendota.com/apps/dota2/images/team_logos/${t.teamId}.png`,
    })),
    count: rows.length,
  });
});

/**
 * GET /api/teams/:id — карточка команды.
 */
router.get('/:id', async (req, res) => {
  const id = Number(req.params['id']);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const rows = await db
    .select()
    .from(teamsTable)
    .where(sql`${teamsTable.teamId} = ${id}`)
    .limit(1);

  if (!rows[0]) {
    res.status(404).json({ error: 'team not found' });
    return;
  }
  res.json(rows[0]);
});

export default router;
