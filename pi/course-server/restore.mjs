// Put a shared course back to an earlier version, e.g. after a bad edit.
//   node pi/course-server/restore.mjs                 list courses
//   node pi/course-server/restore.mjs keperra         list its versions
//   node pi/course-server/restore.mjs keperra 4       make version 4 current again
// Then restart the server: sudo systemctl restart golf-courses
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA = process.env.DATA_DIR ?? path.join(os.homedir(), 'golf-courses');
const [key, ver] = process.argv.slice(2);

if (!key) {
  for (const f of (await fs.readdir(path.join(DATA, 'courses'))).filter((f) => f.endsWith('.json'))) {
    const c = JSON.parse(await fs.readFile(path.join(DATA, 'courses', f), 'utf8'));
    console.log(`${c.key.padEnd(30)} v${c.version}  ${c.updatedAt}  ${c.name}`);
  }
} else if (!ver) {
  const log = (await fs.readFile(path.join(DATA, 'history', `${key}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  let v = 0;
  for (const e of log) {
    v++;
    const what = e.created ? 'created' : (e.restoredFrom ? `restored from v${e.restoredFrom}` : `${e.changed} change(s) on hole${e.holes?.length === 1 ? '' : 's'} ${(e.holes ?? []).map((h) => h.n).join(', ')}`);
    console.log(`v${v}  ${e.at}  by ${e.by ?? '-'}  ${what}`);
  }
  const vs = (await fs.readdir(path.join(DATA, 'history', key))).map((f) => Number(f.slice(1, -5))).sort((a, b) => a - b);
  console.log(`versions kept: ${vs.join(', ')}`);
} else {
  const old = JSON.parse(await fs.readFile(path.join(DATA, 'history', key, `v${ver}.json`), 'utf8'));
  const cur = JSON.parse(await fs.readFile(path.join(DATA, 'courses', `${key}.json`), 'utf8'));
  // A new version number, so phones see it as newer, and edit times bumped so
  // the restored values win over what phones already have.
  const now = Date.now();
  for (const h of old.holes) for (const f of Object.values(h.fields)) f.ts = now;
  const next = { ...old, version: cur.version + 1, updatedAt: new Date(now).toISOString() };
  await fs.writeFile(path.join(DATA, 'courses', `${key}.json`), JSON.stringify(next));
  await fs.writeFile(path.join(DATA, 'history', key, `v${next.version}.json`), JSON.stringify(next));
  await fs.appendFile(path.join(DATA, 'history', `${key}.jsonl`), `${JSON.stringify({ at: next.updatedAt, restoredFrom: Number(ver) })}\n`);
  console.log(`${key}: version ${ver} is now current (v${next.version}). Restart the server: sudo systemctl restart golf-courses`);
}
