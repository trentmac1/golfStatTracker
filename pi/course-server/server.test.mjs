import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'courses-'));
process.env.DATA_DIR = dir;
process.env.ALLOW_ORIGINS = 'https://trentmac1.github.io';
const { start } = await import('./server.mjs');

test('course server: create, find, edit, CORS, history', async () => {
  const server = await start({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const O = { Origin: 'https://trentmac1.github.io', 'Content-Type': 'application/json' };
  const post = (p, body, h = O) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    let r = await post('/courses', { name: 'Keperra Country Golf Club', centre: { lat: -27.41, lon: 152.95 }, holeCount: 27 });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://trentmac1.github.io');
    const { course } = await r.json();
    assert.equal(course.key, 'keperra');
    // Same course under another name, a little way off: found, not duplicated.
    r = await post('/courses', { name: 'Keperra Golf', centre: { lat: -27.412, lon: 152.951 } });
    assert.equal((await r.json()).course.key, 'keperra');
    r = await post('/courses/keperra/edits', { holes: [{ n: 5, fields: { green: { v: { lat: -27.411, lon: 152.952 }, ts: Date.now() - 1000 } } }] });
    const out = await r.json();
    assert.equal(out.changed, 1); assert.equal(out.course.version, 2);
    // A built-in course is created on its first edit.
    r = await post('/courses/ashgrove/edits', { name: 'Ashgrove Golf Club', centre: { lat: -27.44, lon: 152.98 }, holes: [{ n: 1, fields: { tee: { v: { lat: -27.441, lon: 152.981 }, ts: 1 } } }] });
    assert.equal((await r.json()).course.key, 'ashgrove');
    r = await fetch(`${base}/courses?lat=-27.41&lon=152.95&km=3`, { headers: { Origin: O.Origin } });
    assert.deepEqual((await r.json()).courses.map((c) => c.key), ['keperra']);
    r = await fetch(`${base}/courses/keperra`, { method: 'OPTIONS', headers: { Origin: O.Origin } });
    assert.equal(r.status, 204);
    r = await fetch(`${base}/courses`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await post('/courses/keperra/edits', 'nope');
    assert.equal(r.status, 400);
    r = await fetch(`${base}/courses/nothere`);
    assert.equal(r.status, 404);
    const hist = (await fs.readFile(path.join(dir, 'history', 'keperra.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(hist.length, 2);
  } finally { server.close(); }
  // Restart: data is still there.
  const s2 = await start({ port: 0, host: '127.0.0.1' });
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/courses/keperra`);
    assert.equal((await r.json()).course.holes[0].fields.green.v.lat, -27.411);
  } finally { s2.close(); }
});
