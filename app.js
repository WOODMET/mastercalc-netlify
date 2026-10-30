(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });
  const fmt = (n) => money.format(n || 0);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { new: 'Новый', work: 'В работе', ready: 'Готов', done: 'Выдан' };

  const state = { me: null, orders: [], plans: null, lastCalc: null, authMode: 'login' };

  // ---------- API ----------
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* не JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Ошибка сервера (' + res.status + ')');
      err.status = res.status; err.code = data && data.code;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------- Авторизация ----------
  function showAuth() { $('#app-view').hidden = true; $('#auth-view').hidden = false; }
  // режимы: login | register | forgot | reset
  function setAuthMode(mode) {
    state.authMode = mode;
    $('#tab-login').classList.toggle('active', mode === 'login');
    $('#tab-register').classList.toggle('active', mode === 'register');
    const labels = { login: 'Войти', register: 'Создать аккаунт', forgot: 'Отправить ссылку на email', reset: 'Сохранить новый пароль' };
    $('#auth-submit').textContent = labels[mode];
    $('#auth-email').closest('label').hidden = mode === 'reset';
    $('#lbl-password').hidden = mode === 'forgot';
    $('#pw-hint').hidden = mode === 'login';
    $('#lbl-consent').hidden = mode !== 'register';
    $('#auth-forgot').hidden = mode !== 'login';
    $('#auth-back').hidden = mode !== 'forgot' && mode !== 'reset';
    $('.tabs-mini').hidden = mode === 'forgot' || mode === 'reset';
    $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').textContent = ''; $('#auth-info').textContent = '';
  }
  $('#tab-login').onclick = () => setAuthMode('login');
  $('#tab-register').onclick = () => setAuthMode('register');
  $('#auth-forgot').onclick = () => setAuthMode('forgot');
  $('#auth-back').onclick = () => { history.replaceState({}, '', location.pathname); setAuthMode('login'); };

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit'); btn.disabled = true; $('#auth-error').textContent = ''; $('#auth-info').textContent = '';
    const mode = state.authMode;
    try {
      const email = $('#auth-email').value, password = $('#auth-password').value;
      if (mode === 'forgot') {
        await api('/auth/forgot', { method: 'POST', body: { email } });
        $('#auth-info').textContent = 'Если такой аккаунт есть, мы отправили письмо со ссылкой. Проверьте почту (и папку «Спам»).';
      } else if (mode === 'reset') {
        const token = location.hash.replace(/^#reset=/, '');
        const r = await api('/auth/reset', { method: 'POST', body: { token, password } });
        history.replaceState({}, '', location.pathname);
        $('#auth-password').value = ''; state.me = r.user; await startApp();
      } else {
        const body = { email, password };
        if (mode === 'register') body.consent = $('#auth-consent').checked;
        const r = await api('/auth/' + mode, { method: 'POST', body });
        $('#auth-password').value = ''; state.me = r.user; await startApp();
      }
    } catch (err) { $('#auth-error').textContent = err.message; }
    btn.disabled = false;
  });

  $('#logout-btn').onclick = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    state.me = null; state.orders = []; showAuth(); setAuthMode('login');
  };

  // ---------- Старт ----------
  async function startApp() {
    $('#auth-view').hidden = true; $('#app-view').hidden = false;
    applyMe();
    fillSettingsForm();
    await loadOrders();
    loadCalcDraft(); runCalc();
    const params = new URLSearchParams(location.search);
    if (params.get('paid')) {
      history.replaceState({}, '', '/');
      switchTab('plan');
      await syncPayment(true);
    }
  }

  function applyMe() {
    const u = state.me;
    $('#brand-name').textContent = u.settings.brand;
    document.title = u.settings.brand + ' — МастерКалькулятор';
    const b = $('#plan-badge'); b.textContent = u.plan === 'pro' ? 'PRO' : 'FREE'; b.classList.toggle('pro', u.plan === 'pro');
    $('#plan-name').textContent = u.plan === 'pro' ? 'PRO' : 'FREE';
    $('#plan-until').textContent = u.plan === 'pro' ? 'Действует до ' + new Date(u.planUntil).toLocaleDateString('ru-RU') : 'Бесплатный тариф';
    $('#o-csv').textContent = u.plan === 'pro' ? 'Скачать CSV' : 'Скачать CSV (PRO)';
  }

  // ---------- Вкладки ----------
  function switchTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    if (name === 'plan') loadPlans();
    window.scrollTo(0, 0);
  }
  $$('#tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

  // ---------- Калькулятор ----------
  const CALC_FIELDS = { name: '#c-name', length: '#c-length', width: '#c-width', mode: '#c-mode', m2: '#c-m2', sheetPrice: '#c-sheet-price',
    sheetL: '#c-sheet-l', sheetW: '#c-sheet-w', waste: '#c-waste', profit: '#c-profit', labor: '#c-labor', extra: '#c-extra', qty: '#c-qty' };
  const CALC_KEY = 'mk_calc_draft';

  function saveCalcDraft() {
    const d = {};
    for (const k in CALC_FIELDS) d[k] = $(CALC_FIELDS[k]).value;
    try { localStorage.setItem(CALC_KEY, JSON.stringify(d)); } catch (e) { /* приватный режим */ }
  }
  function loadCalcDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(CALC_KEY) || 'null');
      if (d) for (const k in CALC_FIELDS) if (d[k] != null) $(CALC_FIELDS[k]).value = d[k];
    } catch (e) { /* ignore */ }
    toggleMode();
  }
  function toggleMode() {
    const sheet = $('#c-mode').value === 'sheet';
    $('#mode-sheet').hidden = !sheet; $('#mode-m2').hidden = sheet;
  }

  function runCalc() {
    saveCalcDraft();
    const out = $('#calc-out'), err = $('#calc-error'), hint = $('#calc-hint'), btn = $('#calc-to-order');
    state.lastCalc = null; err.textContent = '';
    const empty = !$('#c-length').value && !$('#c-width').value;
    if (empty) { out.hidden = true; btn.hidden = true; hint.hidden = false; return; }
    try {
      const r = window.Calc.calcUnit({
        lengthMm: $('#c-length').value, widthMm: $('#c-width').value, priceMode: $('#c-mode').value,
        pricePerM2: $('#c-m2').value, sheetPrice: $('#c-sheet-price').value,
        sheetLengthMm: $('#c-sheet-l').value, sheetWidthMm: $('#c-sheet-w').value,
        wastePct: $('#c-waste').value, labor: $('#c-labor').value, extra: $('#c-extra').value, profitPct: $('#c-profit').value,
      });
      const qtyRaw = $('#c-qty').value || '1';
      const o = window.Calc.calcOrder({ qty: qtyRaw, unitCost: r.cost, unitPrice: r.price });
      state.lastCalc = { unit: r, order: o };
      hint.hidden = true; out.hidden = false; btn.hidden = false;
      const L = (a, b, cls) => '<div class="line ' + (cls || '') + '"><dt>' + a + '</dt><dd>' + b + '</dd></div>';
      out.innerHTML =
        L('Площадь заготовки', r.areaM2.toLocaleString('ru-RU') + ' м²') +
        L('Цена металла', fmt(r.pricePerM2) + ' / м²') +
        L('Материал без отходов', fmt(r.materialNet)) +
        L('Отходы', fmt(r.materialWaste)) +
        L('Работа + доп. расходы', fmt(r.labor + r.extra)) +
        L('Себестоимость 1 шт.', fmt(r.cost)) +
        L('Прибыль с 1 шт.', fmt(r.profit), 'profit') +
        L('Цена клиенту за 1 шт.', fmt(r.price), 'total') +
        L('Выручка за ' + o.qty + ' шт.', fmt(o.revenue)) +
        L('Прибыль по заказу', fmt(o.profit), 'profit');
    } catch (e) {
      out.hidden = true; btn.hidden = true; hint.hidden = true; err.textContent = e.message;
    }
  }
  Object.values(CALC_FIELDS).forEach((sel) => { $(sel).addEventListener('input', runCalc); });
  $('#c-mode').addEventListener('change', () => { toggleMode(); runCalc(); });
  $('#calc-reset').onclick = () => {
    $('#calc-form').reset();
    ['#c-length', '#c-width', '#c-m2', '#c-sheet-price', '#c-name'].forEach((s) => { $(s).value = ''; });
    $('#c-mode').value = 'm2'; $('#c-waste').value = 10; $('#c-profit').value = 30; $('#c-labor').value = 0; $('#c-extra').value = 0; $('#c-qty').value = 1;
    $('#c-sheet-l').value = 2500; $('#c-sheet-w').value = 1250;
    toggleMode(); runCalc();
  };
  $('#calc-to-order').onclick = () => {
    if (!state.lastCalc) return;
    const u = state.lastCalc.unit, l = $('#c-length').value, w = $('#c-width').value;
    openOrderDialog({
      product: $('#c-name').value, size: l + '×' + w + ' мм', qty: state.lastCalc.order.qty,
      unitCost: u.cost, unitPrice: u.price,
    });
  };

  // ---------- Заказы ----------
  async function loadOrders() {
    try { state.orders = (await api('/orders')).orders; renderOrders(); }
    catch (e) { if (e.status === 401) showAuth(); else toast(e.message); }
  }

  function renderOrders() {
    const q = $('#o-search').value.trim().toLowerCase(), st = $('#o-filter').value;
    const list = state.orders.filter((o) => (!st || o.status === st) &&
      (!q || (o.client + ' ' + o.product).toLowerCase().includes(q)));
    const rev = list.reduce((s, o) => s + o.revenue, 0), prof = list.reduce((s, o) => s + o.profit, 0);
    $('#o-totals').innerHTML = 'Заказов: <b>' + list.length + '</b> Выручка: <b>' + fmt(window.Calc.r2(rev)) + '</b> Прибыль: <b>' + fmt(window.Calc.r2(prof)) + '</b>' +
      (state.me.limits.orders ? ' Лимит FREE: <b>' + state.orders.length + ' / ' + state.me.limits.orders + '</b>' : '');
    $('#o-demo').hidden = state.orders.length > 0;
    $('#o-list').innerHTML = list.length ? list.map((o) =>
      '<article class="order" data-id="' + o.id + '">' +
      '<div class="order-head"><div><h3>' + esc(o.product) + '</h3><div class="muted">' + esc(o.client) + (o.size ? ' · ' + esc(o.size) : '') + '</div></div>' +
      '<div class="muted small">№' + o.id + '</div></div>' +
      '<div class="order-meta">' +
      '<div><span>Количество</span><b>' + o.qty + ' шт.</b></div>' +
      '<div><span>Цена за шт.</span><b>' + fmt(o.unitPrice) + '</b></div>' +
      '<div><span>Выручка</span><b>' + fmt(o.revenue) + '</b></div>' +
      '<div><span>Прибыль</span><b class="' + (o.profit >= 0 ? 'pos' : '') + '">' + fmt(o.profit) + '</b></div></div>' +
      '<div class="order-actions">' +
      '<select data-act="status" aria-label="Статус">' + Object.keys(STATUS).map((k) => '<option value="' + k + '"' + (k === o.status ? ' selected' : '') + '>' + STATUS[k] + '</option>').join('') + '</select>' +
      '<button class="btn ghost" data-act="edit" type="button">Изменить</button>' +
      '<button class="btn ghost" data-act="kp" type="button">КП</button></div></article>'
    ).join('') : '<div class="empty">' + (state.orders.length ? 'Ничего не найдено' : 'Заказов пока нет. Добавьте первый или загрузите демо-данные.') + '</div>';
  }

  $('#o-search').addEventListener('input', renderOrders);
  $('#o-filter').addEventListener('change', renderOrders);
  $('#o-add').onclick = () => openOrderDialog(null);

  $('#o-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn || btn.tagName === 'SELECT') return;
    const o = state.orders.find((x) => x.id === Number(btn.closest('.order').dataset.id)); if (!o) return;
    if (btn.dataset.act === 'edit') openOrderDialog(o, true);
    if (btn.dataset.act === 'kp') openKp(o);
  });
  $('#o-list').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'status') return;
    const o = state.orders.find((x) => x.id === Number(e.target.closest('.order').dataset.id)); if (!o) return;
    try { await saveOrder(Object.assign({}, o, { status: e.target.value }), o.id); toast('Статус обновлён'); }
    catch (err) { toast(err.message); renderOrders(); }
  });

  $('#o-demo').onclick = async () => {
    try { await api('/demo', { method: 'POST' }); await loadOrders(); toast('Демо-данные загружены'); } catch (e) { toast(e.message); }
  };
  $('#o-csv').onclick = () => {
    if (state.me.plan !== 'pro') { toast('Экспорт CSV доступен в тарифе PRO'); switchTab('plan'); return; }
    location.href = '/api/orders.csv';
  };

  async function saveOrder(o, id) {
    const body = { client: o.client, product: o.product, size: o.size, qty: o.qty, status: o.status, unitCost: o.unitCost, unitPrice: o.unitPrice, notes: o.notes };
    const r = id ? await api('/orders/' + id, { method: 'PUT', body }) : await api('/orders', { method: 'POST', body });
    const i = state.orders.findIndex((x) => x.id === r.order.id);
    if (i >= 0) state.orders[i] = r.order; else state.orders.unshift(r.order);
    renderOrders();
    return r.order;
  }

  // Диалог заказа
  const dlg = $('#order-dialog');
  function openOrderDialog(o, editing) {
    o = o || {};
    $('#order-title').textContent = editing ? 'Заказ №' + o.id : 'Новый заказ';
    $('#f-id').value = editing ? o.id : '';
    $('#f-client').value = o.client || ''; $('#f-product').value = o.product || ''; $('#f-size').value = o.size || '';
    $('#f-qty').value = o.qty || 1; $('#f-status').value = o.status || 'new';
    $('#f-cost').value = o.unitCost != null ? o.unitCost : ''; $('#f-price').value = o.unitPrice != null ? o.unitPrice : '';
    $('#f-notes').value = o.notes || ''; $('#f-error').textContent = '';
    $('#f-delete').hidden = !editing;
    previewOrder();
    dlg.showModal();
  }
  function previewOrder() {
    try {
      const c = window.Calc.calcOrder({ qty: $('#f-qty').value, unitCost: $('#f-cost').value, unitPrice: $('#f-price').value });
      $('#f-preview').innerHTML = 'Выручка: <b>' + fmt(c.revenue) + '</b> Прибыль: <b>' + fmt(c.profit) + '</b> Маржа: <b>' + c.marginPct.toLocaleString('ru-RU') + '%</b>';
    } catch (e) { $('#f-preview').innerHTML = '<span class="muted">Укажите количество, себестоимость и цену</span>'; }
  }
  ['#f-qty', '#f-cost', '#f-price'].forEach((s) => $(s).addEventListener('input', previewOrder));
  $('#f-cancel').onclick = () => dlg.close();

  $('#order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#f-error'); err.textContent = '';
    const id = $('#f-id').value ? Number($('#f-id').value) : null;
    try {
      const c = window.Calc.calcOrder({ qty: $('#f-qty').value, unitCost: $('#f-cost').value, unitPrice: $('#f-price').value });
      if (!$('#f-client').value.trim()) throw new Error('Укажите клиента');
      if (!$('#f-product').value.trim()) throw new Error('Укажите изделие');
      await saveOrder({
        client: $('#f-client').value, product: $('#f-product').value, size: $('#f-size').value, qty: c.qty,
        status: $('#f-status').value, unitCost: c.unitCost, unitPrice: c.unitPrice, notes: $('#f-notes').value,
      }, id);
      dlg.close(); toast('Заказ сохранён');
    } catch (ex) {
      err.textContent = ex.message;
      if (ex.code === 'LIMIT') { dlg.close(); switchTab('plan'); toast(ex.message); }
    }
  });

  $('#f-delete').onclick = async () => {
    const id = Number($('#f-id').value);
    if (!id || !confirm('Удалить заказ? Это действие нельзя отменить.')) return;
    try {
      await api('/orders/' + id, { method: 'DELETE' });
      state.orders = state.orders.filter((o) => o.id !== id); renderOrders(); dlg.close(); toast('Заказ удалён');
    } catch (e) { $('#f-error').textContent = e.message; }
  };

  // ---------- Коммерческое предложение ----------
  function kpHtml(o) {
    const s = state.me.settings, pro = state.me.plan === 'pro';
    const d = new Date(), until = new Date(Date.now() + s.kpValidDays * 86400000);
    const ds = (x) => x.toLocaleDateString('ru-RU');
    const num = 'КП-' + o.id + '-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const contacts = [s.companyName, s.address, s.phone, s.email].filter(Boolean).map(esc).join('<br>');
    return '<div class="kp-head"><div><div class="kp-brand">' + esc(s.brand) + '</div><div class="foot">' + contacts + '</div></div>' +
      '<div class="kp-meta"><h2>Коммерческое предложение</h2>№ ' + esc(num) + '<br>от ' + ds(d) + '<br>действительно до ' + ds(until) + '</div></div>' +
      '<p><b>Для:</b> ' + esc(o.client) + '</p>' +
      '<table><thead><tr><th>№</th><th>Наименование</th><th>Размеры / описание</th><th class="n">Кол-во</th><th class="n">Цена, ₽</th><th class="n">Сумма, ₽</th></tr></thead><tbody>' +
      '<tr><td>1</td><td>' + esc(o.product) + '</td><td>' + esc(o.size) + '</td><td class="n">' + o.qty + ' шт.</td><td class="n">' + fmt(o.unitPrice) + '</td><td class="n">' + fmt(o.revenue) + '</td></tr></tbody></table>' +
      '<div class="sum">Итого к оплате: ' + fmt(o.revenue) + '</div>' +
      (s.kpNote ? '<p class="foot">' + esc(s.kpNote).replace(/\n/g, '<br>') + '</p>' : '') +
      (o.notes ? '<p class="foot">' + esc(o.notes).replace(/\n/g, '<br>') + '</p>' : '') +
      (pro ? '' : '<div class="wm">Создано в МастерКалькулятор (бесплатный тариф). Перейдите на PRO, чтобы убрать эту пометку.</div>');
  }
  let currentKp = '';
  function openKp(o) {
    const html = kpHtml(o);
    $('#kp-preview').innerHTML = html; $('#kp-printcopy').innerHTML = html; currentKp = html;
    $('#kp-dialog').showModal();
  }
  $('#kp-close').onclick = () => $('#kp-dialog').close();
  $('#kp-open').onclick = () => {
    const css = 'body{font:14px/1.4 -apple-system,Arial,sans-serif;color:#111;margin:0;padding:16px;background:#fff}.kp-head{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #111;padding-bottom:12px;margin-bottom:16px;flex-wrap:wrap}.kp-brand{font-size:26px;font-weight:800;letter-spacing:.06em}.kp h2{font-size:18px;margin:0 0 4px}.kp-meta{text-align:right;font-size:13px}table{width:100%;border-collapse:collapse;margin:14px 0}th,td{border:1px solid #999;padding:8px 10px;text-align:left;vertical-align:top}th{background:#eee;font-size:13px}.n{text-align:right;white-space:nowrap}.sum{text-align:right;font-size:18px;font-weight:800;margin:8px 0 16px}.foot{font-size:13px;color:#333}.wm{margin-top:18px;font-size:11px;color:#888;border-top:1px solid #ccc;padding-top:8px}';
    const doc = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Коммерческое предложение</title><style>' + css + '</style></head><body><div class="kp">' + currentKp + '</div></body></html>';
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    if (!window.open(url, '_blank')) toast('Разрешите открытие новых вкладок в Safari');
  };
  $('#kp-print').onclick = () => { $('#kp-dialog').close(); setTimeout(() => window.print(), 50); };

  // ---------- Тарифы и оплата ----------
  async function loadPlans() {
    try {
      state.plans = await api('/plans');
      $('#free-limit').textContent = state.plans.freeOrderLimit;
      const box = $('#plan-buttons');
      if (state.me.plan === 'pro') {
        $('#plan-note').textContent = 'PRO активен. Продлить можно в любой момент — срок суммируется.';
      } else {
        $('#plan-note').textContent = state.plans.paymentsConfigured ? 'Оплата проходит на защищённой странице платёжного провайдера. Мы не получаем данные карты.' :
          'Приём оплаты ещё не подключён владельцем сервиса — кнопки покажут сообщение вместо перехода к оплате.';
      }
      box.innerHTML = state.plans.plans.map((p) =>
        '<button class="btn primary big" data-plan="' + esc(p.code) + '" type="button">' + esc(p.title) + ' — ' + fmt(Number(p.price)) + '</button>').join('');
    } catch (e) { toast(e.message); }
  }
  $('#plan-buttons').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-plan]'); if (!b) return;
    b.disabled = true;
    try { const r = await api('/billing/checkout', { method: 'POST', body: { plan: b.dataset.plan } }); location.href = r.url; }
    catch (err) { toast(err.message); b.disabled = false; }
  });
  async function syncPayment(quiet) {
    try {
      const r = await api('/billing/sync', { method: 'POST' });
      const was = state.me.plan; state.me = r.user; applyMe(); renderOrders(); loadPlans();
      if (state.me.plan === 'pro' && was !== 'pro') toast('Оплата подтверждена. Тариф PRO активен.');
      else if (!quiet) toast('Оплата пока не подтверждена провайдером. Попробуйте через минуту.');
    } catch (e) { toast(e.message); }
  }
  $('#plan-sync').onclick = () => syncPayment(false);

  // ---------- Настройки ----------
  function fillSettingsForm() {
    const s = state.me.settings;
    $('#s-brand').value = s.brand; $('#s-company').value = s.companyName; $('#s-phone').value = s.phone;
    $('#s-email').value = s.email; $('#s-address').value = s.address; $('#s-days').value = s.kpValidDays; $('#s-note').value = s.kpNote;
  }
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#s-error').textContent = '';
    try {
      const r = await api('/settings', { method: 'PUT', body: {
        brand: $('#s-brand').value, companyName: $('#s-company').value, phone: $('#s-phone').value, email: $('#s-email').value,
        address: $('#s-address').value, kpValidDays: Number($('#s-days').value), kpNote: $('#s-note').value } });
      state.me.settings = r.settings; applyMe(); toast('Настройки сохранены');
    } catch (err) { $('#s-error').textContent = err.message; }
  });

  // ---------- Инициализация ----------
  (async function init() {
    setAuthMode('login');
    if (location.hash.indexOf('#reset=') === 0) { showAuth(); setAuthMode('reset'); return; }
    try { state.me = (await api('/me')).user; await startApp(); }
    catch (e) { showAuth(); }
  })();
})();
