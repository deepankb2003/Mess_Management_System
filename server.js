'use strict';
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- config (.env is read without any dependency) ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file: fine */ }

const PORT = Number(process.env.PORT) || 8000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mess.db');
const PRICE = {
  Breakfast: Number(process.env.BREAKFAST_PRICE) || 30,
  Lunch: Number(process.env.LUNCH_PRICE) || 60,
  Dinner: Number(process.env.DINNER_PRICE) || 60,
};
const MEALS = Object.keys(PRICE);
const KEEP_WEEKS = Number(process.env.FEEDBACK_KEEP_WEEKS) || 1;
const SESSION_DAYS = 7;

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, roll TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS menu (
  weekday INTEGER NOT NULL, meal TEXT NOT NULL, items TEXT NOT NULL, PRIMARY KEY (weekday, meal));
CREATE TABLE IF NOT EXISTS selections (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, meal TEXT NOT NULL, PRIMARY KEY (user_id, date, meal));
CREATE TABLE IF NOT EXISTS week_payments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, week_start));
CREATE TABLE IF NOT EXISTS feedback (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, meal TEXT NOT NULL, rating INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, date, meal));
`);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_MENU = {
  Breakfast: ['Idli, Sambar, Chutney', 'Poha, Tea', 'Aloo Paratha, Curd', 'Upma, Banana', 'Puri Bhaji', 'Dosa, Sambar', 'Chole Bhature'],
  Lunch: ['Rice, Dal, Mixed Veg, Papad', 'Rice, Rajma, Aloo Gobi', 'Rice, Sambar, Cabbage Fry', 'Rice, Dal Tadka, Paneer', 'Rice, Dalma, Fish/Egg Curry', 'Veg Pulao, Raita', 'Special Thali'],
  Dinner: ['Roti, Dal, Paneer Masala', 'Roti, Mix Veg, Dal Fry', 'Rice, Chicken/Egg Curry', 'Roti, Aloo Matar, Dal', 'Fried Rice, Manchurian', 'Roti, Kadai Veg, Dal', 'Biryani, Raita, Sweet'],
};
const seed = db.prepare('INSERT OR IGNORE INTO menu (weekday, meal, items) VALUES (?, ?, ?)');
for (let d = 0; d < 7; d++) for (const m of MEALS) seed.run(d, m, DEFAULT_MENU[m][d]);

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, user) {
  const a = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(user.hash, 'hex'));
}

// admin account: created / updated from environment on every start
(function ensureAdmin() {
  const id = (process.env.ADMIN_ID || 'ADMIN').toUpperCase();
  let pw = process.env.ADMIN_PASSWORD;
  const existing = db.prepare("SELECT id FROM users WHERE roll = ? AND role = 'staff'").get(id);
  if (!pw && existing) return;
  if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); console.log(`\n  No ADMIN_PASSWORD set. Generated staff login -> ID: ${id}  Password: ${pw}\n`); }
  const { salt, hash } = hashPassword(pw);
  if (existing) db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, existing.id);
  else db.prepare("INSERT INTO users (roll, name, salt, hash, role) VALUES (?, 'Mess Staff', ?, ?, 'staff')").run(id, salt, hash);
})();

function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM feedback WHERE created_at < ?').run(new Date(Date.now() - KEEP_WEEKS * 7 * 864e5).toISOString().replace('T', ' ').slice(0, 19));
}
cleanup();
setInterval(cleanup, 36e5).unref();

// ---------- weekly billing: students tick the meals they will eat and pay for exactly those ----------
const addDays = (str, n) => { const d = new Date(str + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const mondayOf = (str) => { const d = new Date(str + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const isWeekStart = (str) => isDate(str) && mondayOf(str) === str;

function weekSummary(uid, start) {
  const rows = db.prepare('SELECT date, meal FROM selections WHERE user_id = ? AND date BETWEEN ? AND ?').all(uid, start, addDays(start, 6));
  const byDate = {};
  let total = 0;
  for (const r of rows) { (byDate[r.date] ||= []).push(r.meal); total += PRICE[r.meal] || 0; }
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i), meals = byDate[date] || [];
    return { date, meals, subtotal: meals.reduce((t, m) => t + (PRICE[m] || 0), 0) };
  });
  const pay = db.prepare('SELECT amount, method, paid_at FROM week_payments WHERE user_id = ? AND week_start = ?').get(uid, start);
  return { start, end: addDays(start, 6), days, count: rows.length, total, paid: !!pay, paid_amount: pay ? pay.amount : 0, method: pay ? pay.method : null, paid_at: pay ? pay.paid_at : null, due: pay ? 0 : total };
}
const weekPaid = (uid, start) => !!db.prepare('SELECT 1 FROM week_payments WHERE user_id = ? AND week_start = ?').get(uid, start);

function settle(uid, start, method) {
  const w = weekSummary(uid, start);
  if (w.paid) fail(409, 'This week is already paid');
  if (w.total <= 0) fail(400, 'Tick at least one meal before paying');
  db.prepare('INSERT INTO week_payments (user_id, week_start, amount, method) VALUES (?, ?, ?, ?)').run(uid, start, w.total, method);
  return weekSummary(uid, start);
}

// ---------- tiny router ----------
const routes = [];
const route = (method, p, role, fn) => routes.push({ method, p, role, fn });

const attempts = new Map();
function rateLimit(ip) {
  const now = Date.now(), e = attempts.get(ip);
  if (!e || e.reset < now) return attempts.set(ip, { n: 1, reset: now + 15 * 60e3 });
  if (++e.n > 20) fail(429, 'Too many attempts. Try again in a few minutes.');
}

function startSession(res, uid, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), uid, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
const publicUser = (u) => ({ id: u.id, roll: u.roll, name: u.name, role: u.role });

route('POST', '/api/register', null, ({ body, ip, res, secure }) => {
  rateLimit(ip);
  const roll = String(body.roll || '').trim().toUpperCase(), name = String(body.name || '').trim(), pw = String(body.password || '');
  if (!/^[A-Z0-9]{4,20}$/.test(roll)) fail(400, 'Roll number must be 4-20 letters/digits');
  if (name.length < 2 || name.length > 60) fail(400, 'Enter your full name');
  if (pw.length < 8) fail(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE roll = ?').get(roll)) fail(409, 'This roll number is already registered');
  const { salt, hash } = hashPassword(pw);
  const r = db.prepare("INSERT INTO users (roll, name, salt, hash, role) VALUES (?, ?, ?, ?, 'student')").run(roll, name, salt, hash);
  startSession(res, Number(r.lastInsertRowid), secure);
  return { user: { id: Number(r.lastInsertRowid), roll, name, role: 'student' } };
});

route('POST', '/api/login', null, ({ body, ip, res, secure }) => {
  rateLimit(ip);
  const u = db.prepare('SELECT * FROM users WHERE roll = ?').get(String(body.id || '').trim().toUpperCase());
  if (!u || !checkPassword(String(body.password || ''), u)) fail(401, 'Wrong ID or password');
  startSession(res, u.id, secure);
  return { user: publicUser(u) };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(m[1]));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', 'any', ({ user }) => ({ user: publicUser(user), prices: PRICE }));

route('GET', '/api/menu', 'any', () => {
  const menu = {};
  for (const r of db.prepare('SELECT * FROM menu').all()) (menu[r.weekday] ||= {})[r.meal] = r.items;
  return { days: DAYS, meals: MEALS, prices: PRICE, menu };
});

route('PUT', '/api/menu', 'staff', ({ body }) => {
  const wd = Number(body.weekday), meal = body.meal, items = String(body.items || '').trim();
  if (!(wd >= 0 && wd <= 6) || !MEALS.includes(meal)) fail(400, 'Invalid day or meal');
  if (!items || items.length > 200) fail(400, 'Menu items must be 1-200 characters');
  db.prepare('INSERT INTO menu (weekday, meal, items) VALUES (?, ?, ?) ON CONFLICT (weekday, meal) DO UPDATE SET items = excluded.items').run(wd, meal, items);
  return { ok: true };
});

route('GET', '/api/week', 'student', ({ user, query }) => {
  if (!isWeekStart(query.start)) fail(400, 'start must be a Monday (YYYY-MM-DD)');
  return weekSummary(user.id, query.start);
});

function editableDate(uid, date) {
  const today = ymd(new Date());
  if (date < today) fail(400, 'Past days cannot be changed');
  if (date > addDays(today, 28)) fail(400, 'You can only plan up to 4 weeks ahead');
  if (weekPaid(uid, mondayOf(date))) fail(409, 'That week is already paid and locked');
}

route('POST', '/api/select', 'student', ({ user, body }) => {
  const { date, meal, on } = body;
  if (!isDate(date) || !MEALS.includes(meal)) fail(400, 'Invalid date or meal');
  editableDate(user.id, date);
  if (on) db.prepare('INSERT OR IGNORE INTO selections (user_id, date, meal) VALUES (?, ?, ?)').run(user.id, date, meal);
  else db.prepare('DELETE FROM selections WHERE user_id = ? AND date = ? AND meal = ?').run(user.id, date, meal);
  return weekSummary(user.id, mondayOf(date));
});

route('POST', '/api/select-week', 'student', ({ user, body }) => {
  if (!isWeekStart(body.start)) fail(400, 'start must be a Monday');
  if (weekPaid(user.id, body.start)) fail(409, 'That week is already paid and locked');
  const today = ymd(new Date()), limit = addDays(today, 28);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < 7; i++) {
      const date = addDays(body.start, i);
      if (date < today || date > limit) continue;
      for (const meal of MEALS) {
        if (body.on) db.prepare('INSERT OR IGNORE INTO selections (user_id, date, meal) VALUES (?, ?, ?)').run(user.id, date, meal);
        else db.prepare('DELETE FROM selections WHERE user_id = ? AND date = ? AND meal = ?').run(user.id, date, meal);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return weekSummary(user.id, body.start);
});

// Simulated payment: cash or an online method; either immediately records the week as paid.
const PAY_METHODS = { Cash: 'Cash', UPI: 'Online (UPI)', Card: 'Online (Card)', 'Net Banking': 'Online (Net Banking)' };
route('POST', '/api/pay', 'student', ({ user, body }) => {
  if (!isWeekStart(body.start)) fail(400, 'start must be a Monday');
  const label = Object.hasOwn(PAY_METHODS, body.method) ? PAY_METHODS[body.method] : null;
  if (!label) fail(400, 'Choose a payment method');
  return settle(user.id, body.start, label);
});

route('GET', '/api/payments', 'student', ({ user }) => ({
  payments: db.prepare('SELECT week_start, amount, method, paid_at FROM week_payments WHERE user_id = ? ORDER BY week_start DESC LIMIT 30').all(user.id),
}));

route('POST', '/api/feedback', 'student', ({ user, body }) => {
  const rating = Number(body.rating), comment = String(body.comment || '').trim().slice(0, 300);
  if (!MEALS.includes(body.meal) || !(rating >= 1 && rating <= 5) || !Number.isInteger(rating)) fail(400, 'Choose a meal and a rating from 1 to 5');
  db.prepare(`INSERT INTO feedback (user_id, date, meal, rating, comment) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, date, meal) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = CURRENT_TIMESTAMP`)
    .run(user.id, ymd(new Date()), body.meal, rating, comment);
  return { ok: true };
});

route('GET', '/api/staff/feedback', 'staff', () => ({
  summary: db.prepare('SELECT meal, ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM feedback GROUP BY meal').all(),
  recent: db.prepare(`SELECT f.date, f.meal, f.rating, f.comment, u.name, u.roll FROM feedback f JOIN users u ON u.id = f.user_id
    ORDER BY f.created_at DESC LIMIT 50`).all(),
}));

route('GET', '/api/staff/overview', 'staff', ({ query }) => {
  if (!isWeekStart(query.start)) fail(400, 'start must be a Monday (YYYY-MM-DD)');
  const students = db.prepare("SELECT id, roll, name FROM users WHERE role = 'student' ORDER BY roll").all().map((u) => {
    const w = weekSummary(u.id, query.start);
    return { ...u, count: w.count, total: w.total, paid: w.paid, paid_amount: w.paid_amount, due: w.due, method: w.method };
  });
  const demand = {};
  for (const r of db.prepare('SELECT date, meal, COUNT(*) AS c FROM selections WHERE date BETWEEN ? AND ? GROUP BY date, meal').all(query.start, addDays(query.start, 6))) (demand[r.date] ||= {})[r.meal] = r.c;
  return {
    start: query.start, students, demand,
    totals: {
      students: students.length,
      billed: students.reduce((t, x) => t + x.total, 0),
      collected: students.reduce((t, x) => t + x.paid_amount, 0),
      pending: students.reduce((t, x) => t + x.due, 0),
    },
  };
});

route('POST', '/api/staff/pay', 'staff', ({ body }) => {
  if (!isWeekStart(body.start)) fail(400, 'start must be a Monday');
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(body.user_id));
  if (!u) fail(404, 'Student not found');
  return settle(u.id, body.start, 'Cash (staff counter)');
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const STATIC_DIR = path.join(__dirname, 'static');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100e3) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(m[1]), Date.now()) || null;
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApi(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.p === url.pathname);
  if (!r) fail(404, 'Not found');
  const user = sessionUser(req);
  if (r.role) {
    if (!user) fail(401, 'Please log in');
    if ((r.role === 'student' || r.role === 'staff') && user.role !== r.role) fail(403, 'Not allowed for your account');
  }
  let body = {};
  if (req.method !== 'GET') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON required');
    body = await readBody(req);
  }
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  send(res, 200, r.fn({ req, res, user, body, query: Object.fromEntries(url.searchParams), ip, secure }));
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else fail(405, 'Method not allowed');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Mess Management System running at http://localhost:${PORT}`));
