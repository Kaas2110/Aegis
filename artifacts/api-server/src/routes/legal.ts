/**
 * /api/legal/privacy  — Политика конфиденциальности
 * /api/legal/terms    — Условия использования
 *
 * Нужны для публикации в App Store / Google Play / RuStore.
 * Ссылки указывать в кабинетах разработчика:
 *   https://<домен>/api/legal/privacy
 *   https://<домен>/api/legal/terms
 */
import { Router } from "express";

const router = Router();

const HTML_WRAPPER = (title: string, body: string) => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — Aegis</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       background:#080604;color:#d4c5a9;max-width:680px;margin:0 auto;padding:24px 16px 64px;line-height:1.7}
  h1{color:#E8830A;font-size:1.5rem;margin-bottom:4px}
  h2{color:#c7a87a;font-size:1.1rem;margin-top:2rem;margin-bottom:.4rem}
  a{color:#E8830A}
  p,li{font-size:.95rem}
  small{color:#7c6a52;font-size:.8rem}
</style>
</head>
<body>${body}</body>
</html>`;

router.get("/privacy", (_req, res) => {
  const updated = "13 мая 2025 г.";
  const html = HTML_WRAPPER(
    "Политика конфиденциальности",
    `<h1>Политика конфиденциальности</h1>
<small>Последнее обновление: ${updated}</small>

<h2>1. Сбор данных</h2>
<p>Приложение <strong>Aegis</strong> не собирает и не хранит персональные данные пользователей на наших серверах.
Анонимный идентификатор устройства может использоваться для обработки подписки через RevenueCat (см. ниже).</p>

<h2>2. RevenueCat</h2>
<p>Для управления подпиской мы используем сервис <a href="https://www.revenuecat.com/privacy">RevenueCat, Inc.</a>
RevenueCat может получать анонимный идентификатор устройства и информацию о покупках. Политика конфиденциальности
RevenueCat: <a href="https://www.revenuecat.com/privacy">revenuecat.com/privacy</a>.</p>

<h2>3. Аналитика матчей</h2>
<p>Все данные о матчах Dota 2 получаются из открытых источников: OpenDota API, PandaScore API, Stratz API.
Мы не связываем эти данные с личностью пользователя.</p>

<h2>4. Магазины приложений</h2>
<p>При загрузке приложения через Google Play, RuStore или App Store применяется политика
конфиденциальности соответствующего магазина.</p>

<h2>5. Контакт</h2>
<p>Вопросы: <a href="mailto:privacy@aegis-dota.app">privacy@aegis-dota.app</a></p>`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

router.get("/terms", (_req, res) => {
  const updated = "13 мая 2025 г.";
  const html = HTML_WRAPPER(
    "Условия использования",
    `<h1>Условия использования</h1>
<small>Последнее обновление: ${updated}</small>

<h2>1. Принятие условий</h2>
<p>Используя приложение Aegis, вы принимаете настоящие условия. Если вы не согласны — прекратите использование.</p>

<h2>2. Назначение приложения</h2>
<p>Aegis предоставляет аналитические прогнозы по матчам Dota 2 на основе машинного обучения.
Прогнозы носят исключительно <strong>информационный характер</strong> и не являются советом по ставкам.
Точность прогнозов не гарантируется.</p>

<h2>3. Ограничение ответственности</h2>
<p>Авторы не несут ответственности за финансовые решения, принятые на основе данных приложения.
Ставки на спорт сопряжены с риском потери средств.</p>

<h2>4. Подписка</h2>
<p>Premium-подписка предоставляет расширенный доступ к аналитике. Условия и стоимость указаны
в магазине приложений. Отмена — через настройки магазина приложений. Деньги за неиспользованный
период не возвращаются.</p>

<h2>5. Контент третьих сторон</h2>
<p>Данные о матчах получаются из OpenDota, PandaScore, Stratz — публичные API. Мы не гарантируем
их непрерывность или точность.</p>

<h2>6. Изменения</h2>
<p>Условия могут обновляться. Актуальная версия всегда по этой ссылке.</p>

<h2>7. Контакт</h2>
<p><a href="mailto:support@aegis-dota.app">support@aegis-dota.app</a></p>`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
