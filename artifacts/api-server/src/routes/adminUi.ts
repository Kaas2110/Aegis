/**
 * Веб-админка для ноутбука. Отдаёт одностраничное приложение по адресу
 * /api/admin-ui — без сборки, на vanilla JS. Управляет глобальными настройками,
 * метриками модели и переобучением через те же /api/admin/* эндпоинты.
 *
 * Не требует авторизации для самой страницы — токен вводится прямо в UI и
 * хранится в localStorage браузера. На любые fetch к /api/admin/* добавляется
 * заголовок X-Admin-Token.
 */

import { Router, type IRouter } from 'express';

const router: IRouter = Router();

const HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Dota Edge · Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Forum&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ── ПАЛИТРА Dota 2 Reborn ─────────────────────────────────────────── */
  :root {
    --bg: #0a0703;
    --bg-deep: #050300;
    --card: #15100a;
    --card-hi: #1d1610;
    --border: #3a2c1a;
    --border-gold: #6e5226;
    --gold-deep: #3d2a0e;
    --primary: #E6B453;
    --gold-hi: #FFD278;
    --gold-lo: #8a6420;
    --accent: #FFCD42;
    --positive: #5DE8A0;
    --warning: #FFB347;
    --destructive: #D44A3A;
    --text: #F0E4CC;
    --text-soft: #D6C29A;
    --muted: #B5A586;  /* подняли с #8a7a5e — даёт >=4.5:1 контраст для 12-13px */

    --font-display: 'Cinzel', 'Forum', Georgia, serif;
    --font-cyr: 'Forum', Georgia, serif;
    --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 1.5;
    /* Тёмный warm radial-gradient — даёт «глубину» как в фоне меню Dota 2 */
    background-image:
      radial-gradient(ellipse 800px 500px at 50% -200px, rgba(230,180,83,0.06), transparent 70%),
      radial-gradient(ellipse 600px 400px at 90% 80%, rgba(212,74,58,0.04), transparent 70%);
    background-attachment: fixed;
    min-height: 100vh;
  }

  /* ── ШАПКА ─────────────────────────────────────────────────────────── */
  .header {
    position: relative;
    padding: 22px 32px 24px;
    background: linear-gradient(180deg, rgba(230,180,83,0.08), rgba(0,0,0,0));
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
  }
  /* Двойная золотая полоса под шапкой — как разделители HUD Dota 2 */
  .header::before {
    content: '';
    position: absolute;
    left: 0; right: 0; bottom: 2px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--border-gold) 20%, var(--primary) 50%, var(--border-gold) 80%, transparent);
    opacity: 0.7;
  }
  .header::after {
    content: '';
    position: absolute;
    left: 10%; right: 10%; bottom: 0;
    height: 1px;
    background: var(--primary);
    opacity: 0.4;
  }
  .logo-mark {
    width: 44px; height: 44px;
    transform: rotate(45deg);
    background: var(--gold-deep);
    border: 1.5px solid var(--primary);
    box-shadow: 0 0 12px rgba(230,180,83,0.25), inset 0 0 8px rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .logo-mark span {
    transform: rotate(-45deg);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 1px;
    color: var(--primary);
  }
  .header h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 4px;
    flex: 1;
    color: var(--text);
    text-shadow: 0 0 18px rgba(230,180,83,0.35);
  }
  .header h1 .sub {
    display: block;
    font-family: var(--font-display);
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 3.5px;
    color: var(--text-soft);
    margin-top: 4px;
    text-shadow: none;
  }
  .badge {
    padding: 5px 12px;
    border: 1px solid var(--primary);
    background: var(--gold-deep);
    color: var(--primary);
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 2px;
    border-radius: 0;
    text-transform: uppercase;
  }

  /* ── КОНТЕЙНЕР И КАРТОЧКИ ──────────────────────────────────────────── */
  .container {
    max-width: 1180px;
    margin: 0 auto;
    padding: 28px 24px 64px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  @media (max-width: 800px) { .container { grid-template-columns: 1fr; } }

  /* Карточка-«предмет инвентаря»: тонкая золотая рамка + угловые ornaments */
  .card {
    position: relative;
    background:
      linear-gradient(180deg, rgba(230,180,83,0.04), transparent 40%),
      var(--card);
    border: 1px solid var(--border-gold);
    padding: 22px 22px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    border-radius: 0;
  }
  /* Уголки в стиле Dota 2 inventory frames */
  .card::before, .card::after {
    content: '';
    position: absolute;
    width: 14px; height: 14px;
    border: 1.5px solid var(--primary);
    pointer-events: none;
  }
  .card::before {
    top: -1px; left: -1px;
    border-right: none; border-bottom: none;
  }
  .card::after {
    bottom: -1px; right: -1px;
    border-left: none; border-top: none;
  }
  .card.full { grid-column: 1 / -1; }
  .card h2 {
    margin: 0 0 2px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 2px;
    color: var(--primary);
    text-transform: uppercase;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    position: relative;
  }
  .card h2::after {
    content: '';
    position: absolute;
    left: 0; bottom: -1px;
    width: 60px; height: 1px;
    background: var(--primary);
  }
  .card p {
    margin: 0;
    color: var(--muted);
    font-family: var(--font-cyr);
    font-size: 13px;
    line-height: 1.6;
    letter-spacing: 0.2px;
  }
  .row { display: flex; align-items: center; gap: 10px; }
  .row > .grow { flex: 1; }

  /* ── ФОРМЫ ─────────────────────────────────────────────────────────── */
  input, button, select { font-family: inherit; font-size: 14px; }
  input[type=text], input[type=password], input[type=number] {
    background: var(--bg-deep);
    border: 1px solid var(--border-gold);
    color: var(--text);
    padding: 11px 13px;
    border-radius: 0;
    flex: 1;
    outline: none;
    font-family: var(--font-cyr);
    letter-spacing: 0.4px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary), 0 0 14px rgba(230,180,83,0.2);
  }

  /* «Бронзовая» кнопка с золотым градиентом — главный CTA */
  button {
    background: linear-gradient(180deg, var(--gold-hi) 0%, var(--primary) 50%, var(--gold-lo) 100%);
    color: #1a1208;
    border: 1px solid var(--gold-lo);
    padding: 10px 20px;
    border-radius: 0;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 1.8px;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 0.15s;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 4px rgba(0,0,0,0.4);
  }
  button:hover {
    filter: brightness(1.12);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 0 16px rgba(230,180,83,0.35);
  }
  button:active { filter: brightness(0.92); }
  button:disabled { opacity: 0.45; cursor: not-allowed; filter: grayscale(0.5); }

  /* Призрачная кнопка — золотая рамка, тёмная подложка */
  button.ghost {
    background: linear-gradient(180deg, rgba(230,180,83,0.08), transparent);
    border: 1px solid var(--border-gold);
    color: var(--primary);
    box-shadow: none;
    text-shadow: none;
  }
  button.ghost:hover {
    background: linear-gradient(180deg, rgba(230,180,83,0.18), rgba(230,180,83,0.05));
    border-color: var(--primary);
    box-shadow: 0 0 12px rgba(230,180,83,0.2);
  }
  button.danger {
    background: linear-gradient(180deg, rgba(212,74,58,0.18), transparent);
    border: 1px solid var(--destructive);
    color: var(--destructive);
    box-shadow: none;
  }

  /* ── ПЕРЕКЛЮЧАТЕЛЬ ─────────────────────────────────────────────────── */
  .toggle {
    width: 54px; height: 28px;
    background: var(--bg-deep);
    border: 1px solid var(--border-gold);
    border-radius: 0;
    position: relative;
    cursor: pointer;
    transition: all 0.2s;
  }
  .toggle.on {
    background: linear-gradient(180deg, var(--gold-hi), var(--primary));
    border-color: var(--gold-hi);
    box-shadow: 0 0 10px rgba(230,180,83,0.4);
  }
  .toggle::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 22px; height: 22px;
    background: linear-gradient(180deg, #f0e4cc, #c9b690);
    border: 1px solid var(--gold-deep);
    transition: transform 0.2s;
  }
  .toggle.on::after { transform: translateX(24px); background: linear-gradient(180deg, #fff, var(--gold-hi)); }

  /* ── СТАТУС ────────────────────────────────────────────────────────── */
  .status {
    padding: 9px 12px;
    border-radius: 0;
    font-family: var(--font-cyr);
    font-size: 13px;
    letter-spacing: 0.3px;
    display: flex;
    align-items: center;
    gap: 6px;
    border-left: 3px solid;
  }
  .status.ok { background: rgba(93,232,160,0.08); color: var(--positive); border-left-color: var(--positive); }
  .status.warn { background: rgba(255,179,71,0.08); color: var(--warning); border-left-color: var(--warning); }
  .status.err { background: rgba(212,74,58,0.1); color: var(--destructive); border-left-color: var(--destructive); }

  /* ── СТАТИСТИКА (4 ячейки) ─────────────────────────────────────────── */
  .grid4 {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  .stat {
    position: relative;
    background:
      linear-gradient(180deg, rgba(230,180,83,0.06), transparent),
      rgba(0,0,0,0.3);
    border: 1px solid var(--border-gold);
    padding: 16px 8px 14px;
    text-align: center;
  }
  .stat::before {
    content: '';
    position: absolute;
    left: 8px; right: 8px; top: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--primary), transparent);
    opacity: 0.6;
  }
  .stat-val {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    color: var(--primary);
    text-shadow: 0 0 12px rgba(230,180,83,0.3);
    letter-spacing: 0.5px;
  }
  .stat-lab {
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-soft);
    margin-top: 6px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  /* ── ТАБЛИЦЫ ───────────────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td {
    padding: 9px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-cyr);
    letter-spacing: 0.2px;
  }
  th {
    color: var(--primary);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 10px;
    letter-spacing: 1.8px;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border-gold);
  }
  tr:last-child td { border-bottom: none; }
  .ok-pill { color: var(--positive); font-weight: 700; }
  .err-pill { color: var(--destructive); font-weight: 700; }

  /* ── LOGIN ─────────────────────────────────────────────────────────── */
  .login-screen { max-width: 480px; margin: 80px auto; padding: 24px; }
  .login-screen .card { padding: 32px; gap: 18px; }
  .login-screen h2 {
    text-align: center;
    font-size: 17px;
    border-bottom: 1px solid var(--border-gold);
    padding-bottom: 16px;
  }
  .login-screen h2::after { left: 50%; transform: translateX(-50%); width: 80px; }

  /* ── TOAST ─────────────────────────────────────────────────────────── */
  .toast {
    position: fixed;
    bottom: 24px; right: 24px;
    background: var(--card);
    border: 1px solid var(--border-gold);
    padding: 14px 18px;
    border-radius: 0;
    font-family: var(--font-cyr);
    font-size: 14px;
    letter-spacing: 0.3px;
    max-width: 380px;
    z-index: 100;
    transform: translateY(100px);
    opacity: 0;
    transition: all 0.25s;
    box-shadow: 0 6px 24px rgba(0,0,0,0.5);
  }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast.err { border-color: var(--destructive); color: var(--destructive); }
  .toast.ok { border-color: var(--positive); color: var(--positive); }

  /* ── ЧИСЛОВОЙ ВВОД ─────────────────────────────────────────────────── */
  .num-input {
    display: flex; align-items: center; gap: 14px; justify-content: center;
  }
  .num-input button {
    background: linear-gradient(180deg, rgba(230,180,83,0.1), transparent);
    border: 1px solid var(--border-gold);
    color: var(--primary);
    width: 38px; height: 38px;
    padding: 0;
    border-radius: 0;
    font-size: 18px;
    box-shadow: none;
    text-shadow: none;
    letter-spacing: 0;
  }
  .num-input button:hover {
    background: linear-gradient(180deg, rgba(230,180,83,0.2), rgba(230,180,83,0.05));
    border-color: var(--primary);
  }
  .num-input .val {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    min-width: 64px;
    text-align: center;
    color: var(--text);
    text-shadow: 0 0 14px rgba(230,180,83,0.3);
  }
  .small {
    font-family: var(--font-cyr);
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.2px;
  }
  /* Разделитель «◆ — ◆» можно использовать в подписях */
  .ornament { color: var(--primary); opacity: 0.7; }
</style>
</head>
<body>

<div id="loginScreen" class="login-screen" style="display:none;">
  <div class="card">
    <h2><span class="ornament">◆</span> &nbsp;DOTA EDGE&nbsp;·&nbsp;ADMIN&nbsp; <span class="ornament">◆</span></h2>
    <p>Введите ADMIN_TOKEN с сервера. Токен сохранится локально в браузере и не покинет это устройство.</p>
    <input id="loginToken" type="password" placeholder="вставьте токен..." autocomplete="off" />
    <button id="loginBtn">Войти в панель</button>
    <div id="loginError" class="status err" style="display:none;"></div>
  </div>
</div>

<div id="app" style="display:none;">
  <div class="header">
    <div class="logo-mark"><span>DEA</span></div>
    <h1>DOTA EDGE
      <span class="sub">◆ ADMIN PANEL · ANALYTICS CONSOLE ◆</span>
    </h1>
    <span class="badge">Admin</span>
    <button class="ghost" id="logoutBtn">Выйти</button>
  </div>

  <div class="container">

    <!-- Settings -->
    <div class="card">
      <h2>Настройки</h2>
      <p>Глобальные флаги. Изменения применяются сразу для всех клиентов (мобилка и веб).</p>

      <div class="row">
        <div class="grow">
          <div style="font-weight:600;">Подтягивать ставки букмекера</div>
          <div class="small">Включи когда настроишь ODDS_API_KEY на сервере</div>
        </div>
        <div id="bookmakerToggle" class="toggle"></div>
      </div>
      <div id="oddsKeyStatus" class="status warn"></div>

      <div>
        <div style="font-weight:600; margin-bottom: 8px;">Хранить live-снапшоты, дней</div>
        <div class="num-input">
          <button onclick="changePruneDays(-1)">−</button>
          <span class="val" id="pruneDays">7</span>
          <button onclick="changePruneDays(1)">+</button>
        </div>
        <p class="small" style="text-align:center;">Шедулер удаляет старее этого порога раз в сутки. Прематч-исходы не чистятся.</p>
      </div>
    </div>

    <!-- Actions -->
    <div class="card">
      <h2>Действия</h2>
      <p>Ручные триггеры для пайплайна и поддержки БД.</p>

      <button id="retrainBtn">Запустить переобучение модели</button>
      <p class="small">ingest:teams → ingest:matches → train:model → hot-reload. ~1-2 мин.</p>

      <button id="pruneBtn" class="ghost">Очистить live-снапшоты сейчас</button>
      <p class="small">По текущей настройке prune days.</p>

      <button id="oddsCheckBtn" class="ghost">Проверить Odds API</button>
    </div>

    <!-- Live model card -->
    <div class="card full">
      <h2>Live-модель победителя</h2>
      <p>Обучается на исторических live-снапшотах + результатах. Принимает текущую игру и прематч-вероятность как приор → выдаёт обновлённую вероятность каждую минуту.</p>
      <div id="liveModelStatus" class="status warn">Загрузка…</div>
      <div class="grid4" id="liveGrid" style="display:none;">
        <div class="stat"><div class="stat-val" id="lAcc">—</div><div class="stat-lab">Test Accuracy</div></div>
        <div class="stat"><div class="stat-val" id="lBrier">—</div><div class="stat-lab">Brier ↓</div></div>
        <div class="stat"><div class="stat-val" id="lLift">—</div><div class="stat-lab">Lift vs прематч</div></div>
        <div class="stat"><div class="stat-val" id="lSamples">—</div><div class="stat-lab">Sample size</div></div>
      </div>
      <p class="small" id="liveModelMeta"></p>
    </div>

    <!-- Models registry (Wave 2) -->
    <div class="card full">
      <h2>Активные прематч-модели</h2>
      <p class="small">До 8 моделей: 4 кинда (fallback + T1/T2/T3) × 2 версии фичей. v1 = только командные (5 фичей). v2 = команды + герои/драфт (12 фичей). Инференс выбирает v2, если известны 5+5 пиков и все герои есть в hero_stats, иначе падает в v1.</p>
      <table>
        <thead><tr><th>Kind</th><th>Fv</th><th>Active</th><th>Acc</th><th>Brier ↓</th><th>Train N</th><th>Создана</th><th>Версия</th></tr></thead>
        <tbody id="modelsRegistryBody"><tr><td colspan="8" class="small">Загрузка…</td></tr></tbody>
      </table>
    </div>

    <!-- Metrics summary -->
    <div class="card full">
      <h2>Качество прематч-модели (out-of-sample)</h2>
      <p>Считается по реальным исходам матчей в проде из таблицы prematch_outcomes.</p>
      <div class="grid4" id="metricsGrid">
        <div class="stat"><div class="stat-val" id="mAcc">—</div><div class="stat-lab">Accuracy</div></div>
        <div class="stat"><div class="stat-val" id="mBrier">—</div><div class="stat-lab">Brier ↓</div></div>
        <div class="stat"><div class="stat-val" id="mResolved">—</div><div class="stat-lab">Резолвов</div></div>
        <div class="stat"><div class="stat-val" id="mPending">—</div><div class="stat-lab">Ожидают</div></div>
      </div>
    </div>

    <!-- By tier (Wave 1) -->
    <div class="card">
      <h2>По тиру (avg Glicko)</h2>
      <p class="small">T1 ≥1400 · T2 1200–1400 · T3 &lt;1200 · unknown — без рейтинга</p>
      <table>
        <thead><tr><th>Тир</th><th>Accuracy</th><th>Brier ↓</th><th>N</th></tr></thead>
        <tbody id="byTierBody"><tr><td colspan="4" class="small">Загрузка…</td></tr></tbody>
      </table>
    </div>

    <!-- By model -->
    <div class="card">
      <h2>По версиям модели</h2>
      <table>
        <thead><tr><th>Версия</th><th>Accuracy</th><th>Brier</th><th>N</th></tr></thead>
        <tbody id="byModelBody"><tr><td colspan="4" class="small">Загрузка…</td></tr></tbody>
      </table>
    </div>

    <!-- Recent -->
    <div class="card">
      <h2>Последние резолвы</h2>
      <table>
        <thead><tr><th></th><th>Матч</th><th>Прогноз</th><th>Победил</th></tr></thead>
        <tbody id="recentBody"><tr><td colspan="4" class="small">Загрузка…</td></tr></tbody>
      </table>
    </div>

  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const TOKEN_KEY = 'dota_admin_token_v1';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({
    'Content-Type': 'application/json',
    'X-Admin-Token': getToken(),
  }, opts.headers || {});
  const r = await fetch('/api' + path, opts);
  if (r.status === 401) {
    setToken('');
    showLogin('Токен отклонён сервером');
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (kind || '');
  setTimeout(() => { el.className = 'toast'; }, 3500);
}

function showLogin(err) {
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('app').style.display = 'none';
  if (err) {
    const e = document.getElementById('loginError');
    e.textContent = err;
    e.style.display = 'block';
  }
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  loadSettings();
  loadMetrics();
  loadModelStatus();
}

document.getElementById('loginBtn').onclick = async () => {
  const t = document.getElementById('loginToken').value.trim();
  if (!t) return;
  setToken(t);
  try {
    await api('/admin/settings');
    showApp();
  } catch (e) {
    setToken('');
    showLogin('Неверный токен');
  }
};

document.getElementById('logoutBtn').onclick = () => {
  if (confirm('Выйти и удалить токен из браузера?')) {
    setToken('');
    showLogin();
  }
};

let currentSettings = null;

async function loadSettings() {
  try {
    const data = await api('/admin/settings');
    currentSettings = data.settings;
    document.getElementById('pruneDays').textContent = data.settings.liveSnapshotPruneDays;
    const tog = document.getElementById('bookmakerToggle');
    tog.classList.toggle('on', data.settings.useBookmakerOdds);
    const ks = document.getElementById('oddsKeyStatus');
    if (data.oddsApiKeyConfigured) {
      ks.className = 'status ok';
      ks.textContent = '✓ ODDS_API_KEY настроен';
    } else {
      ks.className = 'status warn';
      ks.textContent = '⚠ ODDS_API_KEY не настроен — включение тоггла не сработает';
    }
  } catch (e) { /* handled by api() */ }
}

document.getElementById('bookmakerToggle').onclick = async () => {
  if (!currentSettings) return;
  try {
    const data = await api('/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ useBookmakerOdds: !currentSettings.useBookmakerOdds }),
    });
    currentSettings = data.settings;
    document.getElementById('bookmakerToggle').classList.toggle('on', data.settings.useBookmakerOdds);
    toast('Сохранено', 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
};

async function changePruneDays(delta) {
  if (!currentSettings) return;
  const next = Math.max(1, Math.min(365, currentSettings.liveSnapshotPruneDays + delta));
  if (next === currentSettings.liveSnapshotPruneDays) return;
  try {
    const data = await api('/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ liveSnapshotPruneDays: next }),
    });
    currentSettings = data.settings;
    document.getElementById('pruneDays').textContent = data.settings.liveSnapshotPruneDays;
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}

document.getElementById('retrainBtn').onclick = async () => {
  if (!confirm('Запустить переобучение модели? Это может занять 1-2 минуты.')) return;
  try {
    const r = await api('/admin/retrain', { method: 'POST' });
    toast(r.started ? 'Пайплайн запущен: ' + r.reason : 'Уже идёт', 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
};

document.getElementById('pruneBtn').onclick = async () => {
  try {
    const r = await api('/admin/prune-snapshots', { method: 'POST', body: '{}' });
    toast('Удалено снапшотов: ' + r.deleted + ' (старше ' + r.days + ' дн.)', 'ok');
    loadMetrics();
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
};

document.getElementById('oddsCheckBtn').onclick = async () => {
  try {
    const r = await api('/admin/odds-status');
    if (r.error) toast('Odds API: ' + r.error, 'err');
    else if (r.disabled) toast('Odds API выключен в настройках', 'warn');
    else toast('Odds API OK: ' + (r.events?.length || 0) + ' событий', 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
};

async function loadModelStatus() {
  try {
    const r = await fetch('/api/analytics/model-status').then(x => x.json());
    const live = r.activeLiveModel;
    const status = document.getElementById('liveModelStatus');
    const grid = document.getElementById('liveGrid');
    const meta = document.getElementById('liveModelMeta');
    if (!live) {
      status.className = 'status warn';
      status.textContent = '⏳ Live-модель ещё не обучена. Накапливаются live_snapshots — обучение запустится автоматически на следующем ретрейне (когда наберётся 50+ резолвленных снапшотов).';
      grid.style.display = 'none';
      meta.textContent = '';
      return;
    }
    status.className = 'status ok';
    status.textContent = '✓ Активна: ' + live.version + ' (' + live.algorithm + ')';
    grid.style.display = 'grid';
    document.getElementById('lAcc').textContent = (live.testAccuracy * 100).toFixed(1) + '%';
    document.getElementById('lBrier').textContent = live.brierScore.toFixed(3);
    const lift = live.metadata && typeof live.metadata.liftAcc === 'number'
      ? (live.metadata.liftAcc * 100).toFixed(1) + 'pp'
      : '—';
    document.getElementById('lLift').textContent = lift;
    document.getElementById('lSamples').textContent = (live.trainSize + live.testSize).toString();
    const m = live.metadata || {};
    meta.textContent = 'Train/test матчей: ' + (m.matchesTrain || '?') + '/' + (m.matchesTest || '?')
      + ' · Baseline (только прематч): acc=' + (m.baselineAcc != null ? (m.baselineAcc * 100).toFixed(1) + '%' : '?')
      + ' · Live предсказаний за сессию: ' + (r.worker?.totalLivePredictions ?? 0);

    // Реестр активных моделей (Wave 2)
    const reg = document.getElementById('modelsRegistryBody');
    const versions = r.recentVersions || [];
    if (versions.length === 0) {
      reg.innerHTML = '<tr><td colspan="8" class="small">Моделей нет</td></tr>';
    } else {
      reg.innerHTML = versions.map(v => {
        const acc = v.testAccuracy != null ? (v.testAccuracy * 100).toFixed(1) + '%' : '—';
        const brier = v.brierScore != null ? v.brierScore.toFixed(3) : '—';
        const dt = v.createdAt ? new Date(v.createdAt).toLocaleString('ru-RU') : '—';
        const activeBadge = v.isActive ? '<span style="color:var(--positive)">●</span>' : '<span style="color:var(--muted)">○</span>';
        return '<tr>'
          + '<td>' + escapeHtml(v.kind || '—') + '</td>'
          + '<td>v' + (v.featuresVersion || 1) + '</td>'
          + '<td>' + activeBadge + '</td>'
          + '<td>' + acc + '</td>'
          + '<td>' + brier + '</td>'
          + '<td>' + (v.trainSampleSize ?? '—') + '</td>'
          + '<td class="small">' + escapeHtml(dt) + '</td>'
          + '<td class="small" style="font-family:monospace;font-size:11px">' + escapeHtml(v.version) + '</td>'
          + '</tr>';
      }).join('');
    }
  } catch (e) { /* ignore */ }
}

async function loadMetrics() {
  try {
    const m = await api('/admin/metrics');
    document.getElementById('mAcc').textContent = m.accuracy != null ? (m.accuracy * 100).toFixed(1) + '%' : '—';
    document.getElementById('mBrier').textContent = m.brierScore != null ? m.brierScore.toFixed(3) : '—';
    document.getElementById('mResolved').textContent = m.resolved;
    document.getElementById('mPending').textContent = m.pending;

    const bm = document.getElementById('byModelBody');
    if (m.byModel.length === 0) {
      bm.innerHTML = '<tr><td colspan="4" class="small">Нет резолвов пока</td></tr>';
    } else {
      bm.innerHTML = m.byModel.map(r =>
        '<tr><td>' + escapeHtml(r.modelVersion) + '</td>'
        + '<td>' + (r.accuracy * 100).toFixed(1) + '%</td>'
        + '<td>' + r.brierScore.toFixed(3) + '</td>'
        + '<td>' + r.resolved + '</td></tr>'
      ).join('');
    }

    const bt = document.getElementById('byTierBody');
    if (!m.byTier || m.byTier.length === 0) {
      bt.innerHTML = '<tr><td colspan="4" class="small">Нет резолвов пока</td></tr>';
    } else {
      const tierOrder = { t1: 1, t2: 2, t3: 3, unknown: 4 };
      const sorted = [...m.byTier].sort((a, b) => (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99));
      bt.innerHTML = sorted.map(r =>
        '<tr><td><b>' + r.tier.toUpperCase() + '</b></td>'
        + '<td>' + (r.accuracy * 100).toFixed(1) + '%</td>'
        + '<td>' + r.brierScore.toFixed(3) + '</td>'
        + '<td>' + r.resolved + '</td></tr>'
      ).join('');
    }

    const rec = document.getElementById('recentBody');
    if (m.recent.length === 0) {
      rec.innerHTML = '<tr><td colspan="4" class="small">Нет резолвов</td></tr>';
    } else {
      rec.innerHTML = m.recent.slice(0, 12).map(r => {
        const predR = r.predictedRadiantWinProb >= 0.5;
        const correct = r.actualRadiantWin !== null && predR === r.actualRadiantWin;
        const icon = correct ? '<span class="ok-pill">✓</span>' : '<span class="err-pill">✗</span>';
        const teams = (r.radiantName || '—') + ' vs ' + (r.direName || '—');
        return '<tr><td>' + icon + '</td>'
          + '<td>' + escapeHtml(teams) + '</td>'
          + '<td>R ' + (r.predictedRadiantWinProb * 100).toFixed(0) + '%</td>'
          + '<td>' + (r.actualRadiantWin ? 'Radiant' : 'Dire') + '</td></tr>';
      }).join('');
    }
  } catch (e) { /* handled */ }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bootstrap
if (getToken()) {
  api('/admin/settings').then(showApp).catch(() => showLogin());
} else {
  showLogin();
}

// Auto-refresh metrics every 60s
setInterval(() => { if (getToken()) { loadMetrics(); loadModelStatus(); } }, 60000);
</script>
</body>
</html>`;

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Не кешируем чтобы изменения сразу применялись.
  res.setHeader('Cache-Control', 'no-store');
  res.send(HTML);
});

export default router;
