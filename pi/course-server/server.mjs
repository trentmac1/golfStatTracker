// Golf Tracker course server: shares green, tee and card edits between
// players. Runs on the Raspberry Pi with plain Node (18+), no packages.
//
//   node pi/course-server/server.mjs            (from a clone of the repo)
//
// Settings (environment):
//   PORT=8787                 where it listens (localhost only by default)
//   HOST=127.0.0.1            put a tunnel (Tailscale Funnel / Cloudflare) in front for HTTPS
//   DATA_DIR=~/golf-courses   where course files and history are kept
//   ALLOW_ORIGINS=https://trentmac1.github.io   comma-separated; who may call it
//   WRITES_PER_HOUR=120       per address
//
// API (JSON):
//   GET  /api/health
//   GET  /api/courses?lat=&lon=&km=      shared courses near a point
//   GET  /api/courses/:key               one course
//   POST /api/courses                    find-or-create: { name, centre, holeCount } -> course
//   POST /api/courses/:key/edits         { name?, centre?, holeCount?, holes: [{ n, fields: { green: { v, ts } } }] }
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { mergeShared, validPoint, MAX_HOLES } from '../../webapp/js/coursemerge.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA = process.env.DATA_DIR ?? path.join(os.homedir(), 'golf-courses');
const ORIGINS = (process.env.ALLOW_ORIGINS ?? 'https://trentmac1.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const WRITES_PER_HOUR = Number(process.env.WRITES_PER_HOUR ?? 120);
const MAX_BODY = 128 * 1024;
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const COURSES = path.join(DATA, 'courses');
const HISTORY = path.join(DATA, 'history');

// ---------- storage ----------
const cache = new Map();          // key -> course
const locks = new Map();          // key -> promise chain, so writes to one course run in turn

async function loadAll() {
  await fs.mkdir(COURSES, { recursive: true });
  await fs.mkdir(HISTORY, { recursive: true });
  for (const f of await fs.readdir(COURSES)) {
    if (!f.endsWith('.json')) continue;
    try { const c = JSON.parse(await fs.readFile(path.join(COURSES, f), 'utf8')); cache.set(c.key, c); }
    catch (e) { console.error(`Skipping ${f}: ${e.message}`); }
  }
}

async function save(course, entry) {
  const file = path.join(COURSES, `${course.key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(course));
  await fs.rename(tmp, file);
  cache.set(course.key, course);
  // History lets a bad edit be undone (pi/course-server/README.md): a copy of
  // every version, plus a log of who sent what.
  await fs.mkdir(path.join(HISTORY, course.key), { recursive: true });
  await fs.writeFile(path.join(HISTORY, course.key, `v${course.version}.json`), JSON.stringify(course));
  await fs.appendFile(path.join(HISTORY, `${course.key}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// ---------- helpers ----------
function metres(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const s = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const COMMON = new Set(['golf', 'club', 'course', 'country', 'links', 'the', 'and', 'resort', 'inc']);
const words = (t) => String(t).toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !COMMON.has(w));
function similarName(a, b) {
  const wa = words(a), wb = new Set(words(b));
  if (!wa.length || !wb.size) return String(a).toLowerCase().trim() === String(b).toLowerCase().trim();
  return wa.filter((w) => wb.has(w)).length >= Math.min(wa.length, wb.size) / 2;
}
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const slug = (n) => words(n).join('-').slice(0, 40) || 'course';

function summary(c) {
  return { key: c.key, name: c.name, centre: c.centre, holeCount: c.holeCount, updatedAt: c.updatedAt, version: c.version };
}

// Per-address write budget.
const writes = new Map();
function allowWrite(ip) {
  const now = Date.now();
  const list = (writes.get(ip) ?? []).filter((t) => now - t < 3600e3);
  if (list.length >= WRITES_PER_HOUR) { writes.set(ip, list); return false; }
  list.push(now); writes.set(ip, list);
  return true;
}
const who = (req) => crypto.createHash('sha256').update(String(clientIp(req))).digest('hex').slice(0, 12);
function clientIp(req) {
  return req.headers['cf-connecting-ip'] ?? (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress);
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Too much data'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Not JSON'), { status: 400 }); }
}

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

// ---------- handlers ----------
async function createOrFind(body, req) {
  const name = cleanName(body.name);
  const centre = body.centre;
  if (!name || !validPoint(centre)) throw Object.assign(new Error('A course needs a name and a centre'), { status: 400 });
  // Someone may already have shared it under a slightly different name.
  const near = [...cache.values()].filter((c) => metres(c.centre, centre) < 2500 && similarName(c.name, name))
    .sort((a, b) => metres(a.centre, centre) - metres(b.centre, centre));
  if (near[0]) return near[0];
  if (body.key && KEY_RE.test(body.key) && !cache.has(body.key)) return createCourse(body.key, name, centre, body.holeCount, req);
  let key = slug(name);
  while (cache.has(key)) key = `${slug(name)}-${crypto.randomBytes(2).toString('hex')}`;
  return createCourse(key, name, centre, body.holeCount, req);
}

function createCourse(key, name, centre, holeCount, req) {
  return withLock(key, async () => {
    if (cache.has(key)) return cache.get(key);
    const now = new Date().toISOString();
    const c = { key, name, centre: { lat: centre.lat, lon: centre.lon }, holeCount: Number.isInteger(holeCount) && holeCount >= 1 && holeCount <= MAX_HOLES ? holeCount : 18, holes: [], createdAt: now, updatedAt: now, version: 1 };
    await save(c, { by: who(req), created: true, name });
    return c;
  });
}

async function addEdits(key, body, req) {
  return withLock(key, async () => {
    let c = cache.get(key);
    if (!c) {
      // A built-in course (key fixed in the app) is created on its first edit.
      if (!validPoint(body.centre) || !cleanName(body.name)) throw Object.assign(new Error('No such course'), { status: 404 });
      const now = new Date().toISOString();
      c = { key, name: cleanName(body.name), centre: { lat: body.centre.lat, lon: body.centre.lon }, holeCount: 18, holes: [], createdAt: now, updatedAt: now, version: 0 };
    }
    if (!Array.isArray(body.holes) || body.holes.length > MAX_HOLES) throw Object.assign(new Error('Edits need a list of holes'), { status: 400 });
    const { course, changed } = mergeShared(c, body);
    if (changed || !cache.has(key)) {
      course.updatedAt = new Date().toISOString();
      course.version = (course.version ?? 0) + 1;
      await save(course, { by: who(req), changed, holes: body.holes });
    }
    return { course, changed };
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin && ORIGINS.includes(req.headers.origin) ? req.headers.origin : null;
  if (req.headers.origin && !origin) return send(res, 403, { error: 'This address may not use the course server' });
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);   // ['api', 'courses', key, 'edits']
  if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' }, origin);

  if (req.method === 'GET' && parts[1] === 'health') return send(res, 200, { ok: true, courses: cache.size }, origin);

  if (parts[1] === 'courses' && parts.length === 2) {
    if (req.method === 'GET') {
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      const km = Math.min(Number(url.searchParams.get('km') ?? 30) || 30, 200);
      let list = [...cache.values()];
      if (Number.isFinite(lat) && Number.isFinite(lon) && url.searchParams.has('lat')) {
        list = list.map((c) => ({ c, d: metres(c.centre, { lat, lon }) })).filter((x) => x.d <= km * 1000).sort((a, b) => a.d - b.d).map((x) => x.c);
      }
      return send(res, 200, { courses: list.slice(0, 100).map(summary) }, origin);
    }
    if (req.method === 'POST') {
      if (!allowWrite(clientIp(req))) return send(res, 429, { error: 'Too many updates from here. Try again in an hour.' }, origin);
      return send(res, 200, { course: await createOrFind(await readBody(req), req) }, origin);
    }
  }

  if (parts[1] === 'courses' && parts[2]) {
    const key = parts[2];
    if (!KEY_RE.test(key)) return send(res, 400, { error: 'Bad course key' }, origin);
    if (req.method === 'GET' && parts.length === 3) {
      const c = cache.get(key);
      return c ? send(res, 200, { course: c }, origin) : send(res, 404, { error: 'No such course' }, origin);
    }
    if (req.method === 'POST' && parts[3] === 'edits' && parts.length === 4) {
      if (!allowWrite(clientIp(req))) return send(res, 429, { error: 'Too many updates from here. Try again in an hour.' }, origin);
      const out = await addEdits(key, await readBody(req), req);
      return send(res, 200, out, origin);
    }
  }
  return send(res, 404, { error: 'Not found' }, origin);
}

export async function start({ port = PORT, host = HOST } = {}) {
  await loadAll();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!e.status) console.error(e);
      if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : 'Server error' }, req.headers.origin && ORIGINS.includes(req.headers.origin) ? req.headers.origin : null);
    });
  });
  await new Promise((r) => server.listen(port, host, r));
  console.log(`Course server on http://${host}:${server.address().port}, data in ${DATA}, ${cache.size} courses`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
