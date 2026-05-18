/**
 * One-off smoke: probes 6 RU bookmakers + Bovada. По умолчанию все запросы
 * идут напрямую с текущего IP. Если задан PROXY_URL — дополнительно прогоняет
 * РФ-источники через прокси для сравнения.
 * Run: pnpm --filter @workspace/api-server exec tsx src/scripts/probe-bookmakers.ts
 */
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

type Source = { id: string; url: string; headers: Record<string, string>; ru: boolean };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SOURCES: Source[] = [
  { id: 'fonbet', ru: true, url: 'https://line34.fonbet.ru/api/v1/line/sport/events?sport=12&count=50',
    headers: { Origin: 'https://www.fonbet.ru', Referer: 'https://www.fonbet.ru/sports/esports/' } },
  { id: 'ligastavok', ru: true, url: 'https://line.ligastavok.ru/lsbets/api/v3/line/championships?sportFamilyKind=Esports&take=200',
    headers: { Origin: 'https://www.ligastavok.ru', Referer: 'https://www.ligastavok.ru/bets/esports/dota' } },
  { id: 'pari', ru: true, url: 'https://pari.ru/api/v3/line/events?sportId=33&take=200',
    headers: { Origin: 'https://pari.ru', Referer: 'https://pari.ru/cybersport/dota-2' } },
  { id: 'betboom', ru: true, url: 'https://betboom.ru/api/v3/sports/40/line?take=200',
    headers: { Origin: 'https://betboom.ru', Referer: 'https://betboom.ru/sport/cybersport/dota-2' } },
  { id: '1xstavka', ru: true, url: 'https://1xstavka.ru/LineFeed/Get1x2_VZip?sports=1620&count=200&lng=ru&mode=4&country=1&getEmpty=true',
    headers: { Origin: 'https://1xstavka.ru', Referer: 'https://1xstavka.ru/line/esports/dota-2/' } },
  { id: 'olimp', ru: true, url: 'https://www.olimp.bet/ru/api/lines/get_events?sport=cybersport&subsport=dota-2&take=200',
    headers: { Origin: 'https://www.olimp.bet', Referer: 'https://www.olimp.bet/ru/cybersport/dota-2' } },
  { id: 'bovada', ru: false, url: 'https://www.bovada.lv/services/sports/event/coupon/events/A/description/esports/dota-2',
    headers: { Origin: 'https://www.bovada.lv', Referer: 'https://www.bovada.lv/sports/esports/dota-2' } },
];

async function probe(src: Source, agent: HttpsProxyAgent<string> | undefined): Promise<void> {
  const start = Date.now();
  const tag = `${src.id.padEnd(12)} ${src.ru ? '[RU]' : '[US]'} ${agent ? 'via PROXY' : 'direct  '}`;
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'ru-RU,ru;q=0.9', ...src.headers },
      agent: agent as never,
      signal: AbortSignal.timeout(15_000),
    });
    const ms = Date.now() - start;
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const isJson = ct.includes('json');
    let kind = 'OTHER';
    if (isJson) {
      try { const j = JSON.parse(body); kind = Array.isArray(j) ? `JSON[${j.length}]` : `JSON{${Object.keys(j).slice(0, 4).join(',')}}`; }
      catch { kind = 'JSON(broken)'; }
    } else if (body.trim().startsWith('<')) kind = 'HTML';
    console.log(`${tag} HTTP ${res.status} ${ms}ms  ct=${ct.slice(0, 40)}  size=${body.length}  ${kind}`);
    if (res.status >= 400) console.log(`   first 200: ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`${tag} FAIL ${ms}ms  ${(e as Error).message}`);
  }
}

async function main() {
  console.log('--- напрямую (с текущего IP) ---');
  for (const s of SOURCES) await probe(s, undefined);
  const proxyUrl = process.env['PROXY_URL'];
  if (proxyUrl) {
    console.log(`\n--- через прокси (${proxyUrl.replace(/:\/\/[^@]+@/, '://***@')}) ---`);
    const agent = new HttpsProxyAgent(proxyUrl);
    for (const s of SOURCES.filter(s => s.ru)) await probe(s, agent);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
