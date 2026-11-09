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
CREATE TABLE IF NOT EXISTS skips (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, meal TEXT NOT NULL, PRIMARY KEY (user_id, date, meal));
CREATE TABLE IF NOT EXISTS payments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, month));
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

// ---------- billing ----------
function bill(uid, month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const gross = days * MEALS.reduce((s, k) => s + PRICE[k], 0);
  let skipped = 0, savings = 0;
  for (const r of db.prepare('SELECT meal, COUNT(*) AS c FROM skips WHERE user_id = ? AND date LIKE ? GROUP BY meal').all(uid, month + '-%')) {
    skipped += r.c; savings += r.c * (PRICE[r.meal] || 0);
  }
  const pay = db.prepare('SELECT amount, paid_at, method FROM payments WHERE user_id = ? AND month = ?').get(uid, month);
  const net = gross - savings;
  return { month, days, gross, skipped, savings, net, paid: !!pay, paid_amount: pay ? pay.amount : 0, paid_at: pay ? pay.paid_at : null, method: pay ? pay.method : null, due: pay ? 0 : net };
}
function settle(uid, month, method) {
  if (month > ymd(new Date()).slice(0, 7)) fail(400, 'You cannot pay for a future month');
  const b = bill(uid, month);
  if (b.paid) fail(409, 'This month is already paid');
  db.prepare('INSERT INTO payments (user_id, month, amount, method) VALUES (?, ?, ?, ?)').run(uid, month, b.net, method);
  return bill(uid, month);
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

route('GET', '/api/skips', 'student', ({ user, query }) => {
  if (!isDate(query.from) || !isDate(query.to)) fail(400, 'from/to must be YYYY-MM-DD');
  return { skips: db.prepare('SELECT date, meal FROM skips WHERE user_id = ? AND date BETWEEN ? AND ?').all(user.id, query.from, query.to) };
});

route('POST', '/api/skips', 'student', ({ user, body }) => {
  const { date, meal, skip } = body;
  if (!isDate(date) || !MEALS.includes(meal)) fail(400, 'Invalid date or meal');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const limit = new Date(); limit.setDate(limit.getDate() + 45);
  if (date < ymd(tomorrow)) fail(400, 'Meals can only be skipped from tomorrow onwards');
  if (date > ymd(limit)) fail(400, 'You can only plan up to 45 days ahead');
  if (bill(user.id, date.slice(0, 7)).paid) fail(409, 'That month is already paid and locked');
  if (skip) db.prepare('INSERT OR IGNORE INTO skips (user_id, date, meal) VALUES (?, ?, ?)').run(user.id, date, meal);
  else db.prepare('DELETE FROM skips WHERE user_id = ? AND date = ? AND meal = ?').run(user.id, date, meal);
  return { ok: true };
});

route('GET', '/api/bill', 'student', ({ user, query }) => {
  if (!isMonth(query.month)) fail(400, 'month must be YYYY-MM');
  return bill(user.id, query.month);
});

// Simulated payment: "Pay Now" immediately records the month as paid.
route('POST', '/api/pay', 'student', ({ user, body }) => {
  if (!isMonth(body.month)) fail(400, 'month must be YYYY-MM');
  return settle(user.id, body.month, 'Pay Now');
});

route('GET', '/api/payments', 'student', ({ user }) => ({
  payments: db.prepare('SELECT month, amount, method, paid_at FROM payments WHERE user_id = ? ORDER BY month DESC').all(user.id),
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
  if (!isMonth(query.month)) fail(400, 'month must be YYYY-MM');
  const students = db.prepare("SELECT id, roll, name FROM users WHERE role = 'student' ORDER BY roll").all().map((u) => ({ ...u, ...bill(u.id, query.month) }));
  return {
    students,
    totals: {
      students: students.length,
      billed: students.reduce((s, x) => s + x.net, 0),
      collected: students.reduce((s, x) => s + x.paid_amount, 0),
      pending: students.reduce((s, x) => s + x.due, 0),
    },
  };
});

route('POST', '/api/staff/pay', 'staff', ({ body }) => {
  if (!isMonth(body.month)) fail(400, 'month must be YYYY-MM');
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(body.user_id));
  if (!u) fail(404, 'Student not found');
  return settle(u.id, body.month, 'Staff counter');
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
