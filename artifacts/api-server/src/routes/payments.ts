/**
 * Платёжные маршруты — серверный биллинг через YooKassa.
 * Используется для RuStore APK (RevenueCat там недоступен).
 *
 * Маршруты:
 *   POST /api/payments/checkout          — создать платёж, вернуть URL
 *   POST /api/payments/yookassa/webhook  — принять уведомление от YooKassa
 *   GET  /api/payments/status?deviceId=  — статус подписки для устройства
 *
 * Env:
 *   YOOKASSA_SHOP_ID    — номер магазина (из кабинета ЮKassa)
 *   YOOKASSA_SECRET_KEY — секретный ключ магазина
 */

import { Router } from 'express';
import { eq, and, gt } from 'drizzle-orm';
import { db, serverSubscriptionsTable } from '@workspace/db';
import { logger } from '../lib/logger';

const router = Router();

// ── Константы тарифов ──────────────────────────────────────────────────────

const PLANS = {
  monthly: {
    label:       'Aegis Premium — 1 месяц',
    amount:      '299.00',
    amountRub:   299,
    durationDays: 30,
  },
  annual: {
    label:       'Aegis Premium — 1 год',
    amount:      '1990.00',
    amountRub:   1990,
    durationDays: 365,
  },
} as const;

type Plan = keyof typeof PLANS;

// ── YooKassa HTTP helper ───────────────────────────────────────────────────

function getYookassaAuth(): string {
  const shopId  = process.env['YOOKASSA_SHOP_ID'];
  const secret  = process.env['YOOKASSA_SECRET_KEY'];
  if (!shopId || !secret) throw new Error('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены');
  return 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64');
}

async function yookassaRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotenceKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization:  getYookassaAuth(),
    'Content-Type': 'application/json',
  };
  if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;

  const res = await fetch(`https://api.yookassa.ru/v3${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YooKassa ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── POST /checkout ─────────────────────────────────────────────────────────

function isValidPlan(p: unknown): p is Plan {
  return p === 'monthly' || p === 'annual';
}

router.post('/checkout', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const deviceId: unknown  = body.deviceId;
    const planRaw: unknown   = body.plan;
    const returnUrl: unknown = body.returnUrl;

    if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128) {
      res.status(400).json({ error: 'deviceId обязателен (строка 1-128 символов)' });
      return;
    }
    if (!isValidPlan(planRaw)) {
      res.status(400).json({ error: 'plan должен быть "monthly" или "annual"' });
      return;
    }
    const plan = planRaw;
    const planCfg = PLANS[plan];

    const idempotenceKey = crypto.randomUUID();
    const returnUrlFinal = (typeof returnUrl === 'string' && returnUrl.startsWith('http'))
      ? returnUrl
      : 'aegis://payment-complete';

    const payment = (await yookassaRequest('POST', '/payments', {
      amount:       { value: planCfg.amount, currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: returnUrlFinal },
      capture:      true,
      description:  planCfg.label,
      metadata:     { device_id: deviceId, plan },
    }, idempotenceKey)) as any;

    const paymentId      = String(payment.id);
    const confirmationUrl = String(payment.confirmation?.confirmation_url ?? '');

    await db.insert(serverSubscriptionsTable).values({
      deviceId,
      provider:          'yookassa',
      plan,
      status:            'pending',
      yookassaPaymentId: paymentId,
      amountRub:         planCfg.amountRub,
    });

    logger.info({ deviceId, plan, paymentId }, '[payments] checkout created');

    res.json({
      paymentId,
      confirmationUrl,
      amount:  planCfg.amount,
      plan,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    logger.warn({ err: msg }, '[payments] checkout error');
    if (msg.includes('не настроены')) {
      res.status(503).json({ error: 'Платёжный шлюз не настроен', details: msg });
    } else {
      next(err);
    }
  }
});

// ── POST /yookassa/webhook ─────────────────────────────────────────────────

router.post('/yookassa/webhook', async (req, res, next) => {
  try {
    const event  = req.body?.event as string | undefined;
    const obj    = req.body?.object as any;
    const paymentId = obj?.id as string | undefined;

    if (!paymentId || event !== 'payment.succeeded') {
      res.status(200).json({ ok: true });
      return;
    }

    // Верифицируем, перезапрашивая платёж напрямую у YooKassa
    let verifiedPayment: any;
    try {
      verifiedPayment = await yookassaRequest('GET', `/payments/${paymentId}`);
    } catch (verifyErr: any) {
      logger.warn({ paymentId, err: String(verifyErr) }, '[payments] webhook: verification fetch failed');
      res.status(200).json({ ok: true });
      return;
    }

    if (verifiedPayment?.status !== 'succeeded') {
      logger.info({ paymentId, status: verifiedPayment?.status }, '[payments] webhook: payment not succeeded');
      res.status(200).json({ ok: true });
      return;
    }

    const meta    = verifiedPayment?.metadata ?? {};
    const deviceId = String(meta.device_id ?? '');
    const plan    = String(meta.plan ?? 'monthly') as Plan;
    const planCfg = PLANS[plan] ?? PLANS.monthly;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + planCfg.durationDays * 86_400_000);

    const updated = await db
      .update(serverSubscriptionsTable)
      .set({ status: 'active', startedAt: now, expiresAt, updatedAt: now })
      .where(eq(serverSubscriptionsTable.yookassaPaymentId, paymentId))
      .returning();

    if (updated.length === 0) {
      // Платёж не найден в pending — создаём (может случиться если checkout был на другом сервере)
      await db.insert(serverSubscriptionsTable).values({
        deviceId,
        provider:          'yookassa',
        plan,
        status:            'active',
        yookassaPaymentId: paymentId,
        amountRub:         planCfg.amountRub,
        startedAt:         now,
        expiresAt,
      });
    }

    logger.info({ paymentId, deviceId, plan, expiresAt }, '[payments] subscription activated');
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err: String(err) }, '[payments] webhook error');
    next(err);
  }
});

// ── GET /status ────────────────────────────────────────────────────────────

router.get('/status', async (req, res, next) => {
  try {
    const deviceId = req.query['deviceId'];
    if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128) {
      res.status(400).json({ error: 'deviceId обязателен' });
      return;
    }
    const now = new Date();

    const rows = await db
      .select()
      .from(serverSubscriptionsTable)
      .where(
        and(
          eq(serverSubscriptionsTable.deviceId, deviceId),
          eq(serverSubscriptionsTable.status, 'active'),
          gt(serverSubscriptionsTable.expiresAt, now),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      res.set('Cache-Control', 'no-store');
      res.json({ isSubscribed: false, expiresAt: null, plan: null });
      return;
    }

    const sub = rows[0]!;
    res.set('Cache-Control', 'no-store');
    res.json({
      isSubscribed: true,
      expiresAt:    sub.expiresAt?.toISOString() ?? null,
      plan:         sub.plan,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
