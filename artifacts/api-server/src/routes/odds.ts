import { Router, type IRouter } from 'express';
import {readProviderFeed, providerFeedIsEnabled, FEED_INTERVALS} from '../services/ProviderFeeds';
import {feedIsStale} from '../lib/backgroundFeed';

const router: IRouter = Router();

// Pinnacle scraper удалён 2026-05-16 (T11 cleanup): на Replit-IP сайт даёт
// 403 + требует guest API key. Эндпоинт оставлен как stub чтобы старые клиенты
// не падали на 404; возвращает пустой массив. Если когда-нибудь дойдут руки до
// PINNACLE_GUEST_API_KEY — вернуть нормальный fetch.
router.get('/pinnacle/dota2', (_req, res) => {
  res.json({
    noData: true,
    source: 'pinnacle',
    warning: 'Pinnacle отключён (T11 cleanup, см. docs/changelog.md). Используйте Bovada через /api/bookmakers.',
    data: [],
  });
});

// Read-only legacy integration. Collection requires explicit background enablement.
for (const [path,key] of [['/dota2','odds_api_dota2'],['/sports','odds_api_sports']] as const) {
  router.get(path, async (req,res)=>{
    if (!providerFeedIsEnabled(key)) {
      res.status(503).json({noData:true, unavailable:true, data:[], sports:[], error:'ODDS_API_BACKGROUND_DISABLED'});return;
    }
    try {
      const snapshot=await readProviderFeed(key);
      const stale=feedIsStale(snapshot,FEED_INTERVALS[key]);
      if (snapshot.data===null || stale) {
        res.status(503).json({noData:true, unavailable:true, data:[], sports:[], fetchedAt:snapshot.receivedAt, stale, error:snapshot.error??'background_feed_stale'});return;
      }
      if (snapshot.receivedAt) res.setHeader('X-Aegis-Source-Received-At',snapshot.receivedAt);
      if (key==='odds_api_sports') {res.json(snapshot.data);return;}
      res.json({noData:snapshot.data.length===0, data:(snapshot.data as OddsApiResponse[]).map(transformOddsApiEvent), fetchedAt:snapshot.receivedAt, stale:false});
    } catch(err) {
      req.log.error({err},'Odds snapshot read failed');
      res.status(503).json({noData:true, unavailable:true, data:[], sports:[], error:'background_feed_unavailable'});
    }
  });
}

interface OddsApiResponse {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title: string;
    last_update: string;
    markets: {
      key: string;
      last_update: string;
      outcomes: { name: string; price: number }[];
    }[];
  }[];
}

interface NormalizedOdds {
  eventId: string;
  sportKey: string;
  team1: string;
  team2: string;
  commenceTime: string;
  bookmakers: {
    bookmakerId: string;
    bookmakerName: string;
    team1Odds: number;
    team2Odds: number;
    lastUpdate: string;
    scope: 'series';
  }[];
}

export function transformOddsApiEvent(ev: OddsApiResponse): NormalizedOdds {
  return {
    eventId: ev.id,
    sportKey: ev.sport_key,
    team1: ev.home_team,
    team2: ev.away_team,
    commenceTime: ev.commence_time,
    bookmakers: ev.bookmakers.flatMap(bk =>
      bk.markets
        .filter(m => m.key === 'h2h')
        .flatMap(m => {
          const t1 = m.outcomes.find(o => o.name === ev.home_team)?.price;
          const t2 = m.outcomes.find(o => o.name === ev.away_team)?.price;
          if (typeof t1!=='number' || typeof t2!=='number' || t1<=1 || t2<=1 || !Number.isFinite(t1) || !Number.isFinite(t2)) return [];
          return [{
            bookmakerId: bk.key,
            bookmakerName: bk.title,
            team1Odds: t1,
            team2Odds: t2,
            lastUpdate: m.last_update,
            scope: 'series' as const,
          }];
        })
    ),
  };
}

export default router;
