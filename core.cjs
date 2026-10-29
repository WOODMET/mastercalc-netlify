// Ядро API без внешних зависимостей. Работает на Web Request/Response (Netlify Functions v2).
// Хранилище и fetch передаются снаружи — поэтому всё тестируется без сети.
'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const Calc = require('../../../calc.js');

const FREE_ORDER_LIMIT = 5;
// Цены задаются ТОЛЬКО здесь: сумма платежа никогда не берётся от клиента.
const PLANS = {
  pro_month: { title: 'PRO на 1 месяц', price: '990.00', days: 30 },
  pro_year: { title: 'PRO на 12 месяцев', price: '9900.00', days: 365 },
};
const STATUSES = ['new', 'work', 'ready', 'done'];
const DEFAULT_SETTINGS = { brand: 'WOODMET', companyName: '', phone: '', email: '', address: '', kpValidDays: 7, kpNote: '' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COOKIE = 'mk_session';
const YK = 'https://api.yookassa.ru/v3';

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (s, m, c) => new HttpError(s, m, c);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64url');

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(headers || {}) } });
}

// ---------- пароли и сессии (встроенный crypto, без сторонних пакетов) ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1:${salt.toString('hex')}:${h.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [v, saltHex, hashHex] = String(stored).split(':');
  if (v !== 's1') return false;
  const h = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}
function signToken(uid, ver, secret) {
  const payload = b64(JSON.stringify({ uid, ver: ver || 0, exp: Date.now() + 30 * 86400000 }));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.exp > Date.now() ? { uid: p.uid, ver: p.ver || 0 } : null;
  } catch { return null; }
}
function getCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ---------- вспомогательное ----------
const isPro = (u) => !!(u.planUntil && new Date(u.planUntil).getTime() > Date.now());
const settingsOf = (u) => ({ ...DEFAULT_SETTINGS, ...(u.settings || {}) });
function publicUser(u) {
  const pro = isPro(u);
  return { id: u.id, email: u.email, plan: pro ? 'pro' : 'free', planUntil: pro ? u.planUntil : null,
    settings: settingsOf(u), limits: { orders: pro ? null : FREE_ORDER_LIMIT } };
}
function str(v, name, { min = 0, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw fail(400, `Заполните поле «${name}»`);
  if (s.length > max) throw fail(400, `Поле «${name}» слишком длинное (максимум ${max} символов)`);
  return s;
}
function orderFromBody(b) {
  const status = b.status || 'new';
  if (!STATUSES.includes(status)) throw fail(400, 'Неизвестный статус заказа');
  const qty = Number(b.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 1e6) throw fail(400, 'Количество должно быть целым числом от 1');
  let c;
  try { c = Calc.calcOrder({ qty, unitCost: b.unitCost, unitPrice: b.unitPrice }); } catch (e) { throw fail(400, e.message); }
  return { client: str(b.client, 'Клиент', { min: 1, max: 120 }), product: str(b.product, 'Изделие', { min: 1, max: 120 }),
    size: str(b.size ?? '', 'Размеры', { max: 120 }), notes: str(b.notes ?? '', 'Примечание', { max: 1000 }),
    qty, status, unitCost: c.unitCost, unitPrice: c.unitPrice };
}
function orderOut(o) {
  const c = Calc.calcOrder({ qty: o.qty, unitCost: o.unitCost, unitPrice: o.unitPrice });
  return { id: o.id, client: o.client, product: o.product, size: o.size, notes: o.notes, status: o.status, qty: o.qty,
    unitCost: o.unitCost, unitPrice: o.unitPrice, revenue: c.revenue, totalCost: c.totalCost, profit: c.profit,
    marginPct: c.marginPct, createdAt: o.createdAt, updatedAt: o.updatedAt };
}

// ---------- обработчик ----------
function createApi({ store, env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
  const SECRET = env.SESSION_SECRET;
  const ykConfigured = () => !!(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY && env.APP_URL);
  const ykAuth = () => 'Basic ' + Buffer.from(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`).toString('base64');
  const attempts = new Map(); // простая защита от перебора (на один экземпляр функции)

  const userKey = (email) => `users/${sha(email)}`;
  const getUserById = (id) => store.get(`u/${id}`).then(async (ref) => (ref ? store.get(ref.key) : null));
  const dataKey = (id) => `data/${id}`;
  const loadData = async (id) => (await store.get(dataKey(id))) || { orders: [], nextId: 1 };

  function throttle(req) {
    const ip = (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
    const t = now(), rec = attempts.get(ip) || { n: 0, reset: t + 15 * 60000 };
    if (t > rec.reset) { rec.n = 0; rec.reset = t + 15 * 60000; }
    rec.n += 1; attempts.set(ip, rec);
    if (rec.n > 30) throw fail(429, 'Слишком много попыток. Попробуйте через 15 минут.');
  }

  function sessionCookie(req, user) {
    const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
    return `${COOKIE}=${signToken(user.id, user.tokenVer, SECRET)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`;
  }

  async function requireUser(req) {
    const s = verifyToken(getCookie(req, COOKIE), SECRET);
    const user = s && await getUserById(s.uid);
    // tokenVer растёт при смене пароля — старые сессии перестают действовать
    if (!user || (user.tokenVer || 0) !== s.ver) throw fail(401, 'Требуется вход', 'AUTH');
    return user;
  }

  const mailConfigured = () => !!(env.RESEND_API_KEY && env.MAIL_FROM && env.APP_URL);
  async function sendMail(to, subject, text) {
    const res = await fetchImpl('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
    if (!res.ok) throw new Error('mail HTTP ' + res.status);
  }

  async function settle(paymentId) {
    const pay = await store.get(`payments/${paymentId}`);
    if (!pay) return { ok: false, reason: 'unknown' };
    if (pay.status === 'succeeded') return { ok: true, already: true };
    if (!ykConfigured()) return { ok: false, reason: 'not_configured' };
    const res = await fetchImpl(`${YK}/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: ykAuth() } });
    if (!res.ok) throw new Error('YooKassa HTTP ' + res.status);
    const p = await res.json();
    if (p.status === 'canceled') { pay.status = 'canceled'; await store.set(`payments/${paymentId}`, pay); return { ok: false, reason: 'canceled' }; }
    const valid = p.status === 'succeeded' && p.paid === true && p.amount?.value === pay.amount &&
      p.amount?.currency === 'RUB' && String(p.metadata?.user_id) === String(pay.userId);
    if (!valid) return { ok: false, reason: 'pending' };
    const user = await getUserById(pay.userId);
    if (!user) return { ok: false, reason: 'unknown' };
    // Сначала помечаем платёж, потом продлеваем: повторный вызов не продлит дважды.
    pay.status = 'succeeded'; await store.set(`payments/${paymentId}`, pay);
    const base = Math.max(now(), user.planUntil ? new Date(user.planUntil).getTime() : 0);
    user.planUntil = new Date(base + PLANS[pay.planCode].days * 86400000).toISOString();
    await store.set(userKey(user.email), user);
    return { ok: true };
  }

  async function route(req, path, method) {
    const body = async () => {
      try { return (await req.json()) || {}; } catch { throw fail(400, 'Некорректный JSON'); }
    };
    const isWrite = method !== 'GET';
    if (isWrite && path !== '/billing/webhook') { // защита от CSRF: Origin должен совпадать с хостом
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== new URL(req.url).host) throw fail(403, 'Запрос отклонён');
    }

    if (path === '/auth/register' && method === 'POST') {
      throttle(req);
      const b = await body();
      const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
      if (!EMAIL_RE.test(email) || email.length > 200) throw fail(400, 'Введите корректный email');
      if (password.length < 8 || password.length > 200) throw fail(400, 'Пароль — не короче 8 символов');
      if (b.consent !== true) throw fail(400, 'Для регистрации нужно принять оферту и политику обработки персональных данных');
      if (await store.get(userKey(email))) throw fail(409, 'Этот email уже зарегистрирован');
      const ts = new Date(now()).toISOString();
      const user = { id: sha(email).slice(0, 24), email, passwordHash: await hashPassword(password), planUntil: null,
        settings: {}, createdAt: ts, consentAt: ts, tokenVer: 0, pendingPayments: [] };
      await store.set(userKey(email), user);
      await store.set(`u/${user.id}`, { key: userKey(email) });
      return json(201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, user) });
    }
    if (path === '/auth/forgot' && method === 'POST') {
      throttle(req);
      const email = String((await body()).email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw fail(400, 'Введите корректный email');
      if (!mailConfigured()) throw fail(503, 'Восстановление пароля пока не настроено. Напишите в поддержку.');
      const user = await store.get(userKey(email));
      if (user) { // ответ одинаков для существующих и несуществующих адресов
        const token = crypto.randomBytes(32).toString('base64url');
        await store.set(`resets/${sha(token)}`, { userId: user.id, exp: now() + 3600000 });
        try {
          await sendMail(email, 'Восстановление пароля',
            `Чтобы задать новый пароль, откройте ссылку (действует 1 час):\n${env.APP_URL}/#reset=${token}\n\nЕсли вы не запрашивали восстановление, просто проигнорируйте это письмо.`);
        } catch (e) { console.error('mail error', e.message); throw fail(502, 'Не удалось отправить письмо. Попробуйте позже.'); }
      }
      return json(200, { ok: true });
    }
    if (path === '/auth/reset' && method === 'POST') {
      throttle(req);
      const b = await body(), password = String(b.password || '');
      if (password.length < 8 || password.length > 200) throw fail(400, 'Пароль — не короче 8 символов');
      const key = `resets/${sha(String(b.token || ''))}`;
      const rec = await store.get(key);
      if (!rec || rec.used || rec.exp < now()) throw fail(400, 'Ссылка недействительна или устарела. Запросите новую.');
      const user = await getUserById(rec.userId);
      if (!user) throw fail(400, 'Ссылка недействительна или устарела. Запросите новую.');
      await store.set(key, { ...rec, used: true }); // одноразовая ссылка
      user.passwordHash = await hashPassword(password);
      user.tokenVer = (user.tokenVer || 0) + 1;
      await store.set(userKey(user.email), user);
      return json(200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, user) });
    }
    if (path === '/auth/login' && method === 'POST') {
      throttle(req);
      const b = await body();
      const email = String(b.email || '').trim().toLowerCase();
      const user = await store.get(userKey(email));
      const ok = user && await checkPassword(String(b.password || ''), user.passwordHash);
      if (!ok) throw fail(401, 'Неверный email или пароль');
      return json(200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, user) });
    }
    if (path === '/auth/logout' && method === 'POST') {
      return json(200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }

    if (path === '/billing/webhook' && method === 'POST') {
      const b = await body();
      const id = b?.object?.id;
      if (typeof id !== 'string' || !/^[\w-]{10,64}$/.test(id)) throw fail(400, 'bad request');
      await settle(id); // статус перепроверяется запросом к API провайдера
      return json(200, { ok: true });
    }

    const user = await requireUser(req);

    if (path === '/me' && method === 'GET') return json(200, { user: publicUser(user) });

    if (path === '/settings' && method === 'PUT') {
      const b = await body(), days = Number(b.kpValidDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw fail(400, 'Срок действия КП — от 1 до 365 дней');
      user.settings = { brand: str(b.brand, 'Название бренда', { min: 1, max: 40 }),
        companyName: str(b.companyName ?? '', 'Организация / ИП', { max: 120 }), phone: str(b.phone ?? '', 'Телефон', { max: 40 }),
        email: str(b.email ?? '', 'Email для КП', { max: 120 }), address: str(b.address ?? '', 'Адрес', { max: 200 }),
        kpValidDays: days, kpNote: str(b.kpNote ?? '', 'Примечание в КП', { max: 500 }) };
      await store.set(userKey(user.email), user);
      return json(200, { settings: user.settings });
    }

    if (path === '/orders' && method === 'GET') {
      const d = await loadData(user.id);
      return json(200, { orders: d.orders.map(orderOut).sort((a, b) => b.id - a.id) });
    }
    if (path === '/orders' && method === 'POST') {
      const o = orderFromBody(await body());
      const d = await loadData(user.id);
      if (!isPro(user) && d.orders.length >= FREE_ORDER_LIMIT) {
        throw fail(402, `В бесплатном тарифе — до ${FREE_ORDER_LIMIT} заказов. Удалите старые или перейдите на PRO.`, 'LIMIT');
      }
      const ts = new Date(now()).toISOString();
      const rec = { id: d.nextId, ...o, createdAt: ts, updatedAt: ts };
      d.nextId += 1; d.orders.push(rec);
      await store.set(dataKey(user.id), d);
      return json(201, { order: orderOut(rec) });
    }
    let m = path.match(/^\/orders\/(\d+)$/);
    if (m && method === 'PUT') {
      const id = Number(m[1]), d = await loadData(user.id), i = d.orders.findIndex((x) => x.id === id);
      if (i < 0) throw fail(404, 'Заказ не найден');
      d.orders[i] = { ...d.orders[i], ...orderFromBody(await body()), updatedAt: new Date(now()).toISOString() };
      await store.set(dataKey(user.id), d);
      return json(200, { order: orderOut(d.orders[i]) });
    }
    if (m && method === 'DELETE') {
      const id = Number(m[1]), d = await loadData(user.id), n = d.orders.length;
      d.orders = d.orders.filter((x) => x.id !== id);
      if (d.orders.length === n) throw fail(404, 'Заказ не найден');
      await store.set(dataKey(user.id), d);
      return json(200, { ok: true });
    }
    if (path === '/demo' && method === 'POST') {
      const d = await loadData(user.id);
      if (d.orders.length) throw fail(409, 'Демо-данные можно загрузить только в пустой список заказов');
      const demo = [
        ['ООО «СтройДом»', 'Козырёк входной группы', '1500×800 мм, оцинковка 0,7 мм', 4, 2150, 3100, 'work', 'Монтаж включён'],
        ['Иванов А. П.', 'Отлив оконный', '2000×250 мм, полимер', 12, 480, 720, 'new', ''],
        ['ИП Сидорова', 'Короб вентиляционный', '600×400×1200 мм, нержавейка', 2, 6900, 9800, 'ready', 'Самовывоз'],
        ['Кузнецов В.', 'Парапетная крышка', '1250×300 мм, оцинковка', 30, 390, 560, 'done', 'Оплачено полностью'],
      ];
      const ts = new Date(now()).toISOString();
      for (const [client, product, size, qty, unitCost, unitPrice, status, notes] of demo) {
        d.orders.push({ id: d.nextId++, client, product, size, qty, unitCost, unitPrice, status, notes, createdAt: ts, updatedAt: ts });
      }
      await store.set(dataKey(user.id), d);
      return json(201, { ok: true });
    }
    if (path === '/orders.csv' && method === 'GET') {
      if (!isPro(user)) throw fail(402, 'Экспорт в CSV доступен в тарифе PRO', 'PRO');
      const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
      const L = { new: 'Новый', work: 'В работе', ready: 'Готов', done: 'Выдан' };
      const rows = (await loadData(user.id)).orders.map(orderOut);
      const head = ['№', 'Дата', 'Клиент', 'Изделие', 'Размеры', 'Кол-во', 'Себестоимость шт.', 'Цена шт.', 'Выручка', 'Прибыль', 'Статус'];
      const lines = [head.map(esc).join(';'), ...rows.map((o) => [o.id, o.createdAt, o.client, o.product, o.size, o.qty, o.unitCost, o.unitPrice, o.revenue, o.profit, L[o.status]].map(esc).join(';'))];
      return new Response('﻿' + lines.join('\r\n'), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders.csv"' } });
    }

    if (path === '/plans' && method === 'GET') {
      return json(200, { freeOrderLimit: FREE_ORDER_LIMIT, paymentsConfigured: ykConfigured(),
        plans: Object.entries(PLANS).map(([code, p]) => ({ code, title: p.title, price: p.price, days: p.days })) });
    }
    if (path === '/billing/checkout' && method === 'POST') {
      const b = await body(), plan = PLANS[String(b.plan || '')];
      if (!plan) throw fail(400, 'Неизвестный тариф');
      if (!ykConfigured()) throw fail(503, 'Приём оплаты ещё не подключён. Владелец сервиса должен задать ключи ЮKassa в переменных окружения.');
      const payload = { amount: { value: plan.price, currency: 'RUB' }, capture: true,
        confirmation: { type: 'redirect', return_url: `${env.APP_URL}/?paid=1` },
        description: `${plan.title} (аккаунт ${user.id.slice(0, 8)})`.slice(0, 128), metadata: { user_id: user.id, plan_code: b.plan } };
      if (env.YOOKASSA_SEND_RECEIPT === 'true') {
        payload.receipt = { customer: { email: user.email }, items: [{ description: plan.title.slice(0, 128), quantity: '1.00',
          amount: { value: plan.price, currency: 'RUB' }, vat_code: Number(env.YOOKASSA_VAT_CODE || 1),
          payment_subject: 'service', payment_mode: 'full_payment' }] };
      }
      const res = await fetchImpl(`${YK}/payments`, { method: 'POST',
        headers: { Authorization: ykAuth(), 'Content-Type': 'application/json', 'Idempotence-Key': crypto.randomUUID() },
        body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id || !data.confirmation?.confirmation_url) {
        console.error('YooKassa create error', res.status, JSON.stringify(data));
        throw fail(502, 'Не удалось создать платёж. Попробуйте позже.');
      }
      await store.set(`payments/${data.id}`, { userId: user.id, planCode: b.plan, amount: plan.price, status: 'pending' });
      user.pendingPayments = [...(user.pendingPayments || []), data.id].slice(-10);
      await store.set(userKey(user.email), user);
      return json(200, { url: data.confirmation.confirmation_url });
    }
    if (path === '/billing/sync' && method === 'POST') {
      for (const id of user.pendingPayments || []) { try { await settle(id); } catch (e) { console.error('sync', e.message); } }
      const fresh = await getUserById(user.id);
      return json(200, { user: publicUser(fresh) });
    }
    throw fail(404, 'Не найдено');
  }

  return async function handle(req) {
    if (!SECRET || SECRET.length < 32) return json(500, { error: 'Сервер не настроен: задайте SESSION_SECRET (не короче 32 символов).' });
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '') || '/';
    try { return await route(req, path, req.method); }
    catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code });
      console.error(e);
      return json(500, { error: 'Внутренняя ошибка сервера' });
    }
  };
}

module.exports = { createApi, PLANS, FREE_ORDER_LIMIT };
