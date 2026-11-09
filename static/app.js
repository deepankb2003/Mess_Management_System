'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const state = { user: null, month: ymd(new Date()).slice(0, 7) };

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 2800);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- boot ----------
async function boot() {
  try { state.user = (await api('/me')).user; } catch { state.user = null; }
  $('#who').innerHTML = state.user
    ? `<span class="mute small">${esc(state.user.name)} (${esc(state.user.roll)})</span> <button class="ghost sm" id="out">Log out</button>` : '';
  if (state.user) $('#out').onclick = guard(async () => { await api('/logout', { method: 'POST', body: {} }); boot(); });
  if (!state.user) return authView();
  return state.user.role === 'staff' ? staffView() : studentView();
}

// ---------- auth ----------
function authView() {
  let mode = 'login';
  const draw = () => {
    $('#app').innerHTML = `<div class="card auth"><h1>Welcome</h1>
      <div class="tabs"><button data-m="login" class="${mode === 'login' ? 'on' : ''}">Log in</button><button data-m="register" class="${mode === 'register' ? 'on' : ''}">Register</button></div>
      <form id="f">
        ${mode === 'register' ? '<label>Full name</label><input name="name" required minlength="2" autocomplete="name">' : ''}
        <label>${mode === 'login' ? 'Roll number / Staff ID' : 'Roll number'}</label><input name="id" required autocomplete="username">
        <label>Password ${mode === 'register' ? '(min 8 characters)' : ''}</label><input name="password" type="password" required minlength="${mode === 'register' ? 8 : 1}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
        <p><button style="width:100%">${mode === 'login' ? 'Log in' : 'Create account'}</button></p>
      </form></div>`;
    document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { mode = b.dataset.m; draw(); }));
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      await api(mode === 'login' ? '/login' : '/register', { method: 'POST', body: mode === 'login' ? f : { roll: f.id, name: f.name, password: f.password } });
      boot();
    });
  };
  draw();
}

const monthPicker = (id) => `<input type="month" id="${id}" value="${state.month}" max="${ymd(new Date()).slice(0, 7)}">`;

// ---------- student ----------
async function studentView() {
  const [menu, pays] = await Promise.all([api('/menu'), api('/payments')]);
  const paidMonths = new Set(pays.payments.map((p) => p.month));
  $('#app').innerHTML = `
    <section class="card" id="billBox"></section>
    <section class="card"><h2>Skip a meal</h2><p class="mute small">Tick a meal to skip it. Skipped meals are deducted from your monthly bill. Skips can be set from tomorrow onwards.</p>
      <div class="tablewrap"><table class="skipgrid" id="skipTbl"></table></div></section>
    <div class="grid2">
      <section class="card"><h2>Weekly menu</h2><div class="tablewrap" id="menuBox"></div></section>
      <section class="card"><h2>Rate today's meal</h2>
        <form id="fb"><label>Meal</label><select name="meal">${menu.meals.map((m) => `<option>${m}</option>`).join('')}</select>
        <label>Rating</label><select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`).join('')}</select>
        <label>Comment (optional)</label><textarea name="comment" rows="3" maxlength="300"></textarea>
        <p><button>Send feedback</button></p></form>
        <h3>Payment history</h3>
        ${pays.payments.length ? `<table>${pays.payments.map((p) => `<tr><td>${esc(p.month)}</td><td>${inr(p.amount)}</td><td class="mute small">${esc(p.paid_at)}</td></tr>`).join('')}</table>` : '<p class="mute">No payments yet.</p>'}
      </section></div>`;

  const today = new Date();
  $('#menuBox').innerHTML = `<table><tr><th>Day</th>${menu.meals.map((m) => `<th>${m}<br><span class="mute">${inr(menu.prices[m])}</span></th>`).join('')}</tr>
    ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<tr class="${d === today.getDay() ? 'today' : ''}"><td><b>${menu.days[d].slice(0, 3)}</b></td>${menu.meals.map((m) => `<td>${esc(menu.menu[d]?.[m])}</td>`).join('')}</tr>`).join('')}</table>`;

  async function drawBill() {
    const b = await api('/bill?month=' + state.month);
    $('#billBox').innerHTML = `<div class="row spread"><h2>Monthly bill</h2>${monthPicker('mp')}</div>
      <div class="stats">
        <div class="stat">Full month<b>${inr(b.gross)}</b></div>
        <div class="stat">Skipped (${b.skipped} meals)<b>− ${inr(b.savings)}</b></div>
        <div class="stat">${b.paid ? 'Paid amount' : 'Amount payable'}<b>${inr(b.paid ? b.paid_amount : b.net)}</b></div>
        <div class="stat">Status<b><span class="pill ${b.paid ? 'paid' : 'unpaid'}">${b.paid ? 'PAID' : 'UNPAID'}</span></b></div></div>
      ${b.paid ? `<div class="receipt">✔ Paid ${inr(b.paid_amount)} on ${esc(b.paid_at)} (UTC). This month is now locked.</div>`
        : `<button id="pay" class="green">Pay Now · ${inr(b.net)}</button>`}`;
    $('#mp').onchange = (e) => { if (e.target.value) { state.month = e.target.value; drawBill().catch((x) => toast(x.message, true)); } };
    if (!b.paid) $('#pay').onclick = guard(async () => {
      if (!confirm(`Pay ${inr(b.net)} for ${b.month}?`)) return;
      await api('/pay', { method: 'POST', body: { month: state.month } });
      toast('Payment successful'); studentView();
    });
  }

  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i + 1); return d; });
  const { skips } = await api(`/skips?from=${ymd(days[0])}&to=${ymd(days[13])}`);
  const skipped = new Set(skips.map((s) => s.date + '|' + s.meal));
  $('#skipTbl').innerHTML = `<tr><th>Date</th>${menu.meals.map((m) => `<th>${m}</th>`).join('')}</tr>` + days.map((d) => {
    const ds = ymd(d), locked = paidMonths.has(ds.slice(0, 7));
    return `<tr><td>${menu.days[d.getDay()].slice(0, 3)}, ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}${locked ? ' 🔒' : ''}</td>` +
      menu.meals.map((m) => `<td><input type="checkbox" data-d="${ds}" data-m="${m}" ${skipped.has(ds + '|' + m) ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="Skip ${m} on ${ds}"></td>`).join('') + '</tr>';
  }).join('');
  $('#skipTbl').onchange = async (e) => {
    const c = e.target; if (c.type !== 'checkbox') return;
    try { await api('/skips', { method: 'POST', body: { date: c.dataset.d, meal: c.dataset.m, skip: c.checked } }); await drawBill(); }
    catch (x) { c.checked = !c.checked; toast(x.message, true); }
  };
  $('#fb').onsubmit = guard(async (e) => {
    e.preventDefault(); await api('/feedback', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Thanks for your feedback!'); e.target.reset();
  });
  await drawBill();
}

// ---------- staff ----------
async function staffView() {
  const [menu, fb] = await Promise.all([api('/menu'), api('/staff/feedback')]);
  $('#app').innerHTML = `
    <section class="card"><div class="row spread"><h2>Overview</h2>${monthPicker('mp')}</div><div id="ov"></div></section>
    <div class="grid2">
      <section class="card"><h2>Edit menu</h2><form id="mf">
        <label>Day</label><select name="weekday">${menu.days.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select>
        <label>Meal</label><select name="meal">${menu.meals.map((m) => `<option>${m}</option>`).join('')}</select>
        <label>Items</label><input name="items" required maxlength="200"><p><button>Save menu item</button></p></form></section>
      <section class="card"><h2>Feedback</h2>
        <div class="row">${fb.summary.map((s) => `<div class="stat">${esc(s.meal)}<b>${s.avg} ★</b><span class="small mute">${s.n} ratings</span></div>`).join('') || '<span class="mute">No feedback yet.</span>'}</div>
        <div class="tablewrap" style="max-height:230px;overflow:auto"><table>${fb.recent.map((f) => `<tr><td class="small">${esc(f.date)}<br>${esc(f.meal)}</td><td>${'★'.repeat(f.rating)}</td><td>${esc(f.comment)}<div class="mute small">${esc(f.name)} · ${esc(f.roll)}</div></td></tr>`).join('')}</table></div>
      </section></div>`;
  const fillItems = () => { const f = $('#mf'); f.items.value = menu.menu[f.weekday.value]?.[f.meal.value] || ''; };
  $('#mf').weekday.onchange = $('#mf').meal.onchange = fillItems; fillItems();
  $('#mf').onsubmit = guard(async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    await api('/menu', { method: 'PUT', body: f }); menu.menu[f.weekday][f.meal] = f.items; toast('Menu updated');
  });
  async function drawOverview() {
    const o = await api('/staff/overview?month=' + state.month);
    $('#ov').innerHTML = `<div class="stats">
      <div class="stat">Students<b>${o.totals.students}</b></div><div class="stat">Total billed<b>${inr(o.totals.billed)}</b></div>
      <div class="stat">Collected<b>${inr(o.totals.collected)}</b></div><div class="stat">Pending<b>${inr(o.totals.pending)}</b></div></div>
      <div class="tablewrap"><table><tr><th>Roll</th><th>Name</th><th>Skipped</th><th>Bill</th><th>Status</th><th></th></tr>
      ${o.students.map((s) => `<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${s.skipped}</td><td>${inr(s.paid ? s.paid_amount : s.net)}</td>
        <td><span class="pill ${s.paid ? 'paid' : 'unpaid'}">${s.paid ? 'PAID' : 'DUE'}</span></td>
        <td>${s.paid ? '' : `<button class="sm ghost" data-id="${s.id}">Mark paid</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">No students registered yet.</td></tr>'}</table></div>`;
    $('#ov').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = guard(async () => {
      if (!confirm('Mark this student as paid for ' + state.month + '?')) return;
      await api('/staff/pay', { method: 'POST', body: { user_id: Number(b.dataset.id), month: state.month } }); toast('Marked as paid'); drawOverview();
    })));
  }
  $('#mp').onchange = (e) => { if (e.target.value) { state.month = e.target.value; drawOverview().catch((x) => toast(x.message, true)); } };
  await drawOverview();
}

boot();
