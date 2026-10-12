// GolfCourseAPI parsing and applying a card (shape as documented by the API).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseCourse, applyScorecard, searchScorecards } from '../js/scorecards.js';

const sample = {
  id: 123, club_name: 'Sample Golf Club', course_name: 'Sample Golf Club',
  location: { city: 'Brisbane', state: 'QLD', country: 'Australia', latitude: -27.4, longitude: 153.0 },
  tees: {
    male: [{ tee_name: 'Blue', course_rating: 70.1, slope_rating: 128, total_yards: 6000, par_total: 72,
      holes: Array.from({ length: 18 }, (_, i) => ({ par: i % 6 === 2 ? 3 : i % 6 === 5 ? 5 : 4, yardage: 350, handicap: i + 1 })) }],
    female: [{ tee_name: 'Red', course_rating: 72.0, slope_rating: 130, holes: [{ par: 4, yardage: 300, handicap: 3 }] }],
  },
};

test('normalises a course record', () => {
  const c = normaliseCourse(sample);
  assert.equal(c.name, 'Sample Golf Club');
  assert.equal(c.tees.length, 2);
  assert.equal(c.tees[0].metres, Math.round(6000 * 0.9144));
  assert.equal(c.tees[0].holes[0].metres, Math.round(350 * 0.9144));
  assert.equal(c.tees[1].par, 4);
});

test('applies a card from a starting hole and clears estimates', () => {
  const course = { holes: Array.from({ length: 27 }, (_, i) => ({ n: i + 1, par: 4, si: null, parEstimated: true })), importNotes: ['pars are estimated'] };
  const c = normaliseCourse(sample);
  assert.equal(applyScorecard(course, c, c.tees[0], 10), 18);
  assert.equal(course.holes[9].si, 1);
  assert.equal(course.holes[11].par, 3);
  assert.ok(course.holes[0].parEstimated && !course.holes[9].parEstimated);
  assert.deepEqual([course.rating, course.slope, course.tee], [70.1, 128, 'Blue']);
  assert.deepEqual(course.importNotes, []);
});

test('reports a bad key and the daily limit clearly', async () => {
  const fake = (status) => async () => ({ status, ok: status < 300, json: async () => ({ courses: [] }) });
  await assert.rejects(searchScorecards('x', { key: 'k', fetchFn: fake(401) }), /rejected the key/);
  await assert.rejects(searchScorecards('x', { key: 'k', fetchFn: fake(429) }), /used up/);
  await assert.rejects(searchScorecards('x', { key: '' }), /Add your GolfCourseAPI key/);
  assert.deepEqual(await searchScorecards('x', { key: 'k', fetchFn: fake(200) }), []);
});

test('search results count tees; details use metres when given', () => {
  const c = normaliseCourse({ id: '9', club_name: 'X', course_name: 'X', location: {}, tees: { female: 2, male: 3 } });
  assert.equal(c.teeCount, 5);
  assert.equal(c.tees.length, 0);
  const d = normaliseCourse({ id: '9', club_name: 'X', tees: { male: [{ tee_name: 'Blue', holes: [{ par: 4, yardage: 400, meters: 366 }] }] } });
  assert.equal(d.tees[0].holes[0].metres, 366);
  assert.equal(d.tees[0].holes[0].si, null);
});
