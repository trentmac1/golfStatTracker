// Build Ashgrove's greens (OSM outlines + QldDem heights) as the app does, and
// save them for testing the 3D green view.
import fs from 'node:fs';
import { buildCourseGreens } from '../../webapp/js/greens.js';
import { newCourse, BUILT_IN_COURSES } from '../../webapp/js/config.js';
const out = {};
for (const key of ['ashgrove']) {
  const c = BUILT_IN_COURSES.find((s) => s.key === key);
  const course = newCourse('x', c.name, c.pars, c.centre, c.si);
  const osmData = JSON.parse(fs.readFileSync(`webapp/data/osm/${key}.json`));
  const r = await buildCourseGreens(course, { osmData, fetchFn: fetch, say: (m) => console.log(m) });
  console.log(key, 'ok', r.ok, 'slopes', r.slopes, 'problems', JSON.stringify(r.problems));
  out[key] = course.holes.map((h) => ({ n: h.n, par: h.par, tee: h.tee, green: h.green, shape: h.shape, features: h.features }));
}
fs.writeFileSync('greens-3d.json', JSON.stringify(out));
