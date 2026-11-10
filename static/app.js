'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
const fmt = (s) => { const d = new Date(s + 'T00:00:00'); return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`; };
const state = { user: null, start: mondayOf(new Date()) };

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

const weekNav = (canPrev, canNext) => `<div class="row spread"><button class="ghost sm" id="prevW" ${canPrev ? '' : 'disabled'}>← Previous week</button>
  <b>Mon ${fmt(state.start)} – Sun ${fmt(addDays(state.start, 6))}</b><button class="ghost sm" id="nextW" ${canNext ? '' : 'disabled'}>Next week →</button></div>`;
const statusPill = (paid) => `<span class="pill ${paid ? 'paid' : 'unpaid'}">${paid ? 'PAID' : 'UNPAID'}</span>`;

// ---------- pay dialog: cash (instant) or online ----------
function payDialog(w, done) {
  const o = document.createElement('div'); o.className = 'modal';
  o.innerHTML = `<div class="card"><h2>Pay ${inr(w.total)}</h2><p class="mute small">${w.count} meals, ${fmt(w.start)} – ${fmt(w.end)}. Choose how you want to pay.</p>
    <div class="opts"><button class="opt" data-k="cash">💵 Pay in cash<small>Marked as paid immediately</small></button>
    <button class="opt" data-k="online">📱 Pay online<small>UPI, card or net banking</small></button></div>
    <div id="onl" hidden><label>Online method</label><select id="om"><option>UPI</option><option>Card</option><option>Net Banking</option></select>
    <p><button id="conf" class="green">Confirm online payment</button></p></div>
    <p><button class="ghost sm" id="cx">Cancel</button></p></div>`;
  document.body.appendChild(o);
  const pay = guard(async (method) => {
    await api('/pay', { method: 'POST', body: { start: w.start, method } });
    o.remove(); toast('Payment successful'); done();
  });
  o.querySelector('[data-k=cash]').onclick = () => pay('Cash');
  o.querySelector('[data-k=online]').onclick = () => { o.querySelector('#onl').hidden = false; };
  o.querySelector('#conf').onclick = () => pay(o.querySelector('#om').value);
  o.querySelector('#cx').onclick = () => o.remove();
  o.onclick = (e) => { if (e.target === o) o.remove(); };
}

// ---------- student ----------
async function studentView() {
  const [menu, pays] = await Promise.all([api('/menu'), api('/payments')]);
  $('#app').innerHTML = `
    <section class="card" id="weekBox"></section>
    <div class="grid2">
      <section class="card"><h2>Weekly menu</h2><div class="tablewrap" id="menuBox"></div></section>
      <section class="card"><h2>Rate a meal</h2>
        <form id="fb"><label>Meal</label><select name="meal">${menu.meals.map((m) => `<option>${m}</option>`).join('')}</select>
        <label>Rating</label><select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`).join('')}</select>
        <label>Comment (optional)</label><textarea name="comment" rows="3" maxlength="300"></textarea>
        <p><button>Send feedback</button></p></form>
        <h3>Payment history</h3>
        ${pays.payments.length ? `<table>${pays.payments.map((p) => `<tr><td>${fmt(p.week_start)} – ${fmt(addDays(p.week_start, 6))}</td><td>${inr(p.amount)}</td><td>${esc(p.method)}</td></tr>`).join('')}</table>` : '<p class="mute">No payments yet.</p>'}
      </section></div>`;
  const todayIdx = new Date().getDay();
  $('#menuBox').innerHTML = `<table><tr><th>Day</th>${menu.meals.map((m) => `<th>${m}</th>`).join('')}</tr>
    ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<tr class="${d === todayIdx ? 'today' : ''}"><td><b>${menu.days[d].slice(0, 3)}</b></td>${menu.meals.map((m) => `<td>${esc(menu.menu[d]?.[m])}</td>`).join('')}</tr>`).join('')}</table>`;
  $('#fb').onsubmit = guard(async (e) => {
    e.preventDefault(); await api('/feedback', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Thanks for your feedback!'); e.target.reset();
  });

  const today = ymd(new Date()), limit = addDays(today, 28), thisMon = mondayOf(new Date());
  const draw = (w) => {
    $('#weekBox').innerHTML = `<h2>Choose your meals</h2>
      <p class="mute small">Tick the meals you will eat. You pay only for the meals you tick. Today and later days can be changed until the week is paid.</p>
      ${weekNav(state.start > thisMon, state.start < mondayOf(limit))}
      <div class="tablewrap"><table class="skipgrid" id="tbl"><tr><th>Day</th>${menu.meals.map((m) => `<th>${m}<br><span class="mute">${inr(menu.prices[m])}</span></th>`).join('')}<th>Day total</th></tr>
      ${w.days.map((d) => { const wd = new Date(d.date + 'T00:00:00').getDay(), ok = !w.paid && d.date >= today && d.date <= limit;
        return `<tr class="${d.date === today ? 'today' : ''}"><td><b>${menu.days[wd].slice(0, 3)}</b> ${fmt(d.date)}</td>` +
          menu.meals.map((m) => `<td><label class="cell"><input type="checkbox" data-d="${d.date}" data-m="${m}" ${d.meals.includes(m) ? 'checked' : ''} ${ok ? '' : 'disabled'} aria-label="${m} on ${d.date}"><span class="small mute">${esc(menu.menu[wd]?.[m])}</span></label></td>`).join('') +
          `<td><b>${inr(d.subtotal)}</b></td></tr>`; }).join('')}</table></div>
      ${w.paid ? '' : `<div class="row" style="margin-top:10px"><button class="ghost sm" id="allW">Tick all</button><button class="ghost sm" id="noneW">Clear all</button></div>`}
      <div class="stats"><div class="stat">Meals ticked<b>${w.count}</b></div>
        <div class="stat">${w.paid ? 'Paid amount' : 'Total to pay'}<b>${inr(w.paid ? w.paid_amount : w.total)}</b></div>
        <div class="stat">Status<b>${statusPill(w.paid)}</b></div></div>
      ${w.paid ? `<div class="receipt">✔ Paid ${inr(w.paid_amount)} via ${esc(w.method)} on ${esc(w.paid_at)} (UTC). This week is now locked.</div>`
        : `<button id="pay" class="green" ${w.total ? '' : 'disabled'}>Pay Now · ${inr(w.total)}</button>`}`;
    $('#prevW').onclick = () => { state.start = addDays(state.start, -7); load(); };
    $('#nextW').onclick = () => { state.start = addDays(state.start, 7); load(); };
    $('#tbl').onchange = async (e) => {
      const c = e.target; if (c.type !== 'checkbox') return;
      try { draw(await api('/select', { method: 'POST', body: { date: c.dataset.d, meal: c.dataset.m, on: c.checked } })); }
      catch (x) { toast(x.message, true); load(); }
    };
    if (!w.paid) {
      $('#allW').onclick = guard(async () => draw(await api('/select-week', { method: 'POST', body: { start: w.start, on: true } })));
      $('#noneW').onclick = guard(async () => draw(await api('/select-week', { method: 'POST', body: { start: w.start, on: false } })));
      $('#pay').onclick = () => payDialog(w, () => studentView());
    }
  };
  const load = guard(async () => draw(await api('/week?start=' + state.start)));
  await load();
}

// ---------- staff ----------
async function staffView() {
  const [menu, fb] = await Promise.all([api('/menu'), api('/staff/feedback')]);
  $('#app').innerHTML = `
    <section class="card"><h2>Weekly overview</h2><div id="ov"></div></section>
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
  const draw = guard(async () => {
    const o = await api('/staff/overview?start=' + state.start);
    const dayRows = Array.from({ length: 7 }, (_, i) => addDays(state.start, i));
    $('#ov').innerHTML = `${weekNav(true, true)}
      <div class="stats"><div class="stat">Students<b>${o.totals.students}</b></div><div class="stat">Total billed<b>${inr(o.totals.billed)}</b></div>
        <div class="stat">Collected<b>${inr(o.totals.collected)}</b></div><div class="stat">Pending<b>${inr(o.totals.pending)}</b></div></div>
      <h3>Meals to prepare</h3><div class="tablewrap"><table><tr><th>Day</th>${menu.meals.map((m) => `<th>${m}</th>`).join('')}</tr>
        ${dayRows.map((d) => `<tr><td>${menu.days[new Date(d + 'T00:00:00').getDay()].slice(0, 3)} ${fmt(d)}</td>${menu.meals.map((m) => `<td>${o.demand[d]?.[m] || 0}</td>`).join('')}</tr>`).join('')}</table></div>
      <h3 style="margin-top:14px">Students</h3><div class="tablewrap"><table><tr><th>Roll</th><th>Name</th><th>Meals</th><th>Amount</th><th>Status</th><th></th></tr>
      ${o.students.map((s) => `<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${s.count}</td><td>${inr(s.paid ? s.paid_amount : s.total)}</td>
        <td>${statusPill(s.paid)}${s.method ? `<div class="mute small">${esc(s.method)}</div>` : ''}</td>
        <td>${s.paid || !s.total ? '' : `<button class="sm ghost" data-id="${s.id}">Mark paid (cash)</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">No students registered yet.</td></tr>'}</table></div>`;
    $('#prevW').onclick = () => { state.start = addDays(state.start, -7); draw(); };
    $('#nextW').onclick = () => { state.start = addDays(state.start, 7); draw(); };
    $('#ov').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = guard(async () => {
      if (!confirm('Mark this student as paid in cash for this week?')) return;
      await api('/staff/pay', { method: 'POST', body: { user_id: Number(b.dataset.id), start: state.start } }); toast('Marked as paid'); draw();
    })));
  });
  await draw();
}

boot();
