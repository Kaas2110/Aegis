/**
 * Public landing page for YooKassa registration:
 *   GET /         — main landing (redirects to /landing)
 *   GET /landing  — product page with store badges
 *   GET /landing/requisites — реквизиты самозанятого (required by YooKassa)
 *
 * These routes are mounted at the root level (not under /api) via app.ts.
 */
import { Router } from "express";

const router = Router();

const INN = "420550801632";
const SUPPORT_EMAIL = "nirvana211096@gmail.com";
const PRODUCT_NAME = "Aegis";
const PRODUCT_DESC = "Аналитика матчей Dota 2 на основе машинного обучения. Прогнозы для 15 рынков ставок, живые обновления, история матчей.";

const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #080604;
    color: #d4c5a9;
    min-height: 100vh;
  }
  a { color: #E8830A; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .nav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid #1e1a14;
    position: sticky; top: 0;
    background: rgba(8,6,4,0.95);
    backdrop-filter: blur(8px);
    z-index: 100;
  }
  .nav-logo { display: flex; align-items: center; gap: 10px; }
  .nav-logo svg { width:36px; height:36px; }
  .nav-logo span { font-size: 1.3rem; font-weight: 700; color: #E8830A; letter-spacing: -0.5px; }
  .nav-links { display: flex; gap: 24px; font-size: .9rem; }
  .nav-links a { color: #a0926e; }
  .nav-links a:hover { color: #E8830A; text-decoration: none; }

  .hero {
    text-align: center;
    padding: 80px 24px 60px;
    max-width: 760px;
    margin: 0 auto;
  }
  .hero-badge {
    display: inline-block;
    background: rgba(232,131,10,0.15);
    color: #E8830A;
    border: 1px solid rgba(232,131,10,0.3);
    border-radius: 999px;
    padding: 4px 14px;
    font-size: .8rem;
    font-weight: 600;
    letter-spacing: .5px;
    text-transform: uppercase;
    margin-bottom: 24px;
  }
  .hero h1 {
    font-size: clamp(2rem, 5vw, 3.2rem);
    font-weight: 800;
    color: #fff;
    line-height: 1.15;
    margin-bottom: 20px;
  }
  .hero h1 span { color: #E8830A; }
  .hero p {
    font-size: 1.1rem;
    color: #a0926e;
    line-height: 1.7;
    margin-bottom: 40px;
  }

  .stores {
    display: flex; flex-wrap: wrap; gap: 14px;
    justify-content: center;
    margin-bottom: 56px;
  }
  .store-btn {
    display: flex; align-items: center; gap: 10px;
    background: #13110d;
    border: 1px solid #2a241a;
    border-radius: 12px;
    padding: 12px 20px;
    color: #d4c5a9;
    font-size: .9rem;
    cursor: pointer;
    transition: border-color .2s, background .2s;
    min-width: 170px;
  }
  .store-btn:hover { border-color: #E8830A; background: #1a1610; text-decoration: none; }
  .store-btn svg { width: 28px; height: 28px; flex-shrink: 0; }
  .store-btn-inner { display: flex; flex-direction: column; align-items: flex-start; }
  .store-btn-sub { font-size: .7rem; color: #7c6a52; }
  .store-btn-name { font-weight: 600; color: #fff; font-size: .95rem; }
  .store-soon { opacity: .45; cursor: default; }
  .store-soon:hover { border-color: #2a241a; background: #13110d; }

  .features {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
    max-width: 900px;
    margin: 0 auto 80px;
    padding: 0 24px;
  }
  .feature-card {
    background: #0e0b08;
    border: 1px solid #1e1a14;
    border-radius: 16px;
    padding: 24px;
  }
  .feature-icon { font-size: 1.8rem; margin-bottom: 12px; }
  .feature-card h3 { color: #fff; font-size: 1rem; margin-bottom: 8px; }
  .feature-card p { color: #7c6a52; font-size: .875rem; line-height: 1.6; }

  .pricing {
    max-width: 600px;
    margin: 0 auto 80px;
    padding: 0 24px;
    text-align: center;
  }
  .pricing h2 { color: #fff; font-size: 1.6rem; margin-bottom: 32px; }
  .pricing-cards { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  .pricing-card {
    flex: 1; min-width: 200px;
    background: #0e0b08;
    border: 1px solid #2a241a;
    border-radius: 16px;
    padding: 28px 24px;
    text-align: center;
  }
  .pricing-card.highlight { border-color: #E8830A; }
  .pricing-card .label { font-size: .8rem; color: #7c6a52; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 12px; }
  .pricing-card .price { font-size: 2rem; font-weight: 800; color: #fff; }
  .pricing-card .price span { font-size: 1rem; font-weight: 400; color: #7c6a52; }
  .pricing-card .save { margin-top: 6px; font-size: .8rem; color: #5DE8A0; }

  .footer {
    border-top: 1px solid #1e1a14;
    padding: 32px 24px;
    text-align: center;
    font-size: .85rem;
    color: #4a3f2f;
  }
  .footer a { color: #7c6a52; }
  .footer-links { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; margin-bottom: 16px; }

  /* Requisites page */
  .req-page { max-width: 640px; margin: 0 auto; padding: 40px 24px 80px; }
  .req-page h1 { color: #E8830A; font-size: 1.6rem; margin-bottom: 8px; }
  .req-page .subtitle { color: #7c6a52; font-size: .9rem; margin-bottom: 36px; }
  .req-table { width: 100%; border-collapse: collapse; }
  .req-table tr { border-bottom: 1px solid #1e1a14; }
  .req-table td { padding: 14px 8px; font-size: .95rem; vertical-align: top; }
  .req-table td:first-child { color: #7c6a52; width: 45%; }
  .req-table td:last-child { color: #fff; font-weight: 500; }
  .req-section { color: #E8830A; font-size: .75rem; font-weight: 700; text-transform: uppercase;
                  letter-spacing: .8px; padding: 20px 8px 6px; border-bottom: none !important; }
  .req-note { margin-top: 24px; background: rgba(232,131,10,0.08); border: 1px solid rgba(232,131,10,0.2);
              border-radius: 10px; padding: 14px 16px; font-size: .85rem; color: #a0926e; line-height: 1.6; }
`;

const logoSvg = `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="18" cy="18" r="18" fill="#1a1208"/>
  <path d="M18 6 L28 12 L28 24 L18 30 L8 24 L8 12 Z" stroke="#E8830A" stroke-width="1.5" fill="none"/>
  <path d="M18 11 L24 14.5 L24 21.5 L18 25 L12 21.5 L12 14.5 Z" fill="#E8830A" opacity="0.15"/>
  <circle cx="18" cy="18" r="3" fill="#E8830A"/>
</svg>`;

const ruStoreSvg = `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="28" height="28" rx="6" fill="#0167FF"/>
  <path d="M7 8h7c2.2 0 4 1.8 4 4s-1.8 4-4 4H9v4H7V8zm2 6h5c1.1 0 2-.9 2-2s-.9-2-2-2H9v4z" fill="white"/>
  <path d="M19 14l2 6h-2l-.5-1.5h-2L16 20h-2l2-6h3zm-1.5 3.5l-.5-1.5-.5 1.5h1z" fill="white"/>
</svg>`;

const googlePlaySvg = `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="28" height="28" rx="6" fill="#13110d"/>
  <path d="M7 7.8l10.5 6.2-2.2 2.2L7 7.8z" fill="#EA4335"/>
  <path d="M7 20.2l8.3-8.3 2.2 2.2L7 20.2z" fill="#4285F4"/>
  <path d="M7 7.8L15.3 14 7 20.2V7.8z" fill="#34A853"/>
  <path d="M15.3 14l4.5-2.7c.7-.4.7-1.2 0-1.6L17.5 8.5 15.3 14z" fill="#FBBC05"/>
  <path d="M15.3 14l2.2 2.2 2.3-1.4c.7-.4.7-1.2 0-1.6L15.3 14z" fill="#EA4335"/>
</svg>`;

const appStoreSvg = `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="28" height="28" rx="6" fill="#13110d"/>
  <path d="M14 5c-.8 1.5-1.3 3.2-.3 4.8H10c-.6 0-1 .4-1 1s.4 1 1 1h1.3L8 18h2.2l1-2h5.6l1 2H20l-3.3-7.2H18c.6 0 1-.4 1-1s-.4-1-1-1h-3.7c.8-1.3 1-3 0-4.8H14z" fill="white"/>
  <path d="M11.8 14l1.2-2.6 1.2 2.6h-2.4z" fill="white"/>
</svg>`;

function navHtml(currentPath = "") {
  return `<nav class="nav">
  <div class="nav-logo">${logoSvg}<span>${PRODUCT_NAME}</span></div>
  <div class="nav-links">
    <a href="/landing">Главная</a>
    <a href="/landing/requisites">Реквизиты</a>
    <a href="/api/legal/terms">Оферта</a>
    <a href="/api/legal/privacy">Конфиденциальность</a>
  </div>
</nav>`;
}

function footerHtml() {
  return `<footer class="footer">
  <div class="footer-links">
    <a href="/landing/requisites">Реквизиты</a>
    <a href="/api/legal/terms">Условия использования</a>
    <a href="/api/legal/privacy">Политика конфиденциальности</a>
    <a href="mailto:${SUPPORT_EMAIL}">Поддержка</a>
  </div>
  <div>© ${new Date().getFullYear()} ${PRODUCT_NAME}. Все права защищены.</div>
</footer>`;
}

function page(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — ${PRODUCT_NAME}</title>
<style>${css}</style>
</head>
<body>${navHtml()}${body}${footerHtml()}</body>
</html>`;
}

// ── GET /landing ──────────────────────────────────────────────────────────────
router.get("/", (req, res) => res.redirect("/landing"));

router.get("/landing", (_req, res) => {
  const html = page(PRODUCT_NAME, `
<section class="hero">
  <div class="hero-badge">Dota 2 Analytics</div>
  <h1>Прогнозы матчей<br/><span>на основе ML</span></h1>
  <p>${PRODUCT_DESC}</p>

  <div class="stores">
    <a class="store-btn store-soon" title="Скоро в RuStore" href="#" onclick="return false">
      ${ruStoreSvg}
      <div class="store-btn-inner">
        <span class="store-btn-sub">Скоро в</span>
        <span class="store-btn-name">RuStore</span>
      </div>
    </a>
    <a class="store-btn store-soon" title="Скоро в Google Play" href="#" onclick="return false">
      ${googlePlaySvg}
      <div class="store-btn-inner">
        <span class="store-btn-sub">Скоро в</span>
        <span class="store-btn-name">Google Play</span>
      </div>
    </a>
    <a class="store-btn store-soon" title="Скоро в App Store" href="#" onclick="return false">
      ${appStoreSvg}
      <div class="store-btn-inner">
        <span class="store-btn-sub">Скоро в</span>
        <span class="store-btn-name">App Store</span>
      </div>
    </a>
  </div>
</section>

<div class="features">
  <div class="feature-card">
    <div class="feature-icon">🧠</div>
    <h3>ML-прогнозы</h3>
    <p>LightGBM-модели, обученные на 28 000+ профессиональных матчах. Точность до 81%.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">⚡</div>
    <h3>Живые обновления</h3>
    <p>Прогноз live-матча обновляется каждые 60 секунд с учётом текущей ситуации на карте.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">📊</div>
    <h3>15 рынков</h3>
    <p>Победитель, тотал убийств, первая кровь, длительность матча и другие рынки.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">🛡️</div>
    <h3>Профессиональные матчи</h3>
    <p>Только профессиональная сцена: TI, Major, DPC-лиги. Свежие данные каждый день.</p>
  </div>
</div>

<div class="pricing">
  <h2>Тарифы</h2>
  <div class="pricing-cards">
    <div class="pricing-card">
      <div class="label">Месяц</div>
      <div class="price">299 <span>₽/мес</span></div>
    </div>
    <div class="pricing-card highlight">
      <div class="label">Год</div>
      <div class="price">1990 <span>₽/год</span></div>
      <div class="save">Экономия 589 ₽</div>
    </div>
  </div>
</div>
`);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── GET /landing/requisites ───────────────────────────────────────────────────
router.get("/landing/requisites", (_req, res) => {
  const html = page("Реквизиты", `
<div class="req-page">
  <h1>Реквизиты</h1>
  <p class="subtitle">Реквизиты исполнителя для оплаты через сервис ЮKassa</p>

  <table class="req-table">
    <tr><td colspan="2" class="req-section">Исполнитель</td></tr>
    <tr><td>Статус</td><td>Самозанятый</td></tr>
    <tr><td>ИНН</td><td>${INN}</td></tr>

    <tr><td colspan="2" class="req-section">Услуга</td></tr>
    <tr><td>Наименование</td><td>Подписка на приложение «${PRODUCT_NAME}» — аналитика матчей Dota 2</td></tr>
    <tr><td>Тип</td><td>Цифровой контент / информационная услуга</td></tr>
    <tr><td>Ставка НПД</td><td>6% (доход от юридических лиц) / 4% (от физических лиц)</td></tr>

    <tr><td colspan="2" class="req-section">Тарифы</td></tr>
    <tr><td>Месячная подписка</td><td>299 ₽</td></tr>
    <tr><td>Годовая подписка</td><td>1 990 ₽</td></tr>

    <tr><td colspan="2" class="req-section">Контакты</td></tr>
    <tr><td>Email поддержки</td><td><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></td></tr>
  </table>

  <div class="req-note">
    Оплата производится через сервис <strong>ЮKassa</strong> (АО «Национальная платёжная корпорация»).
    Чек формируется автоматически и направляется на email плательщика. Исполнитель применяет
    специальный налоговый режим «Налог на профессиональный доход» и зарегистрирован в приложении
    «Мой налог».
  </div>
</div>
`);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
