// Defaults and the seeded home course.
export const APP_VERSION = '0.3.2';

export const DEFAULT_BAG = ['Dr', '3W', '5W', '4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW'];

export const LIES = [
  ['tee', 'Tee'], ['fairway', 'Fairway'], ['rough', 'Rough'], ['bunker', 'Bunker'], ['other', 'Other'],
];

// Ashgrove Golf Club, 863 Waterworks Rd, The Gap. Pars from the published
// scorecard (par 68). Check them against the card in the pro shop; they can be
// edited under Courses. Green and tee positions are left empty: set them on the
// map from home, or tap "On green" during a round.
export const ASHGROVE = {
  name: 'Ashgrove Golf Club',
  centre: { lat: -27.4433, lon: 152.9615 },
  pars: [4, 4, 3, 5, 4, 3, 4, 4, 3, 3, 4, 4, 3, 5, 4, 4, 3, 4],
  // Stroke index from the same scorecard (GolfPass).
  si: [4, 8, 6, 18, 14, 10, 12, 2, 16, 3, 1, 13, 17, 11, 7, 5, 9, 15],
};

// Pine Rivers Golf Club, 245 Narangba Rd, Kurwongbah. Par 70, pars agreed by
// two published scorecards (golfingrecord.com, 18birdies).
export const PINE_RIVERS = {
  name: 'Pine Rivers Golf Club',
  centre: { lat: -27.2308, lon: 152.9749 },
  pars: [4, 4, 5, 4, 3, 5, 4, 3, 4, 3, 4, 4, 4, 3, 4, 4, 4, 4],
  // Stroke index from golfingrecord.com's card.
  si: [18, 1, 3, 5, 12, 17, 6, 7, 15, 16, 8, 10, 4, 11, 2, 13, 14, 9],
};

// Courses built into the app. Each is added once to a phone that doesn't have
// it yet (matched by key, or by name for courses added before keys existed),
// so new ones arrive with an app update without touching existing data.
export const BUILT_IN_COURSES = [
  { key: 'ashgrove', ...ASHGROVE },
  { key: 'pine-rivers', ...PINE_RIVERS },
];

// Fallback map centre when nothing else is known (Brisbane).
// Course sharing server (pi/course-server), reached over HTTPS. Empty until
// the Pi is set up; a phone can also set its own in Backup & settings.
export const COURSE_SERVER = 'https://rolls.tail2ff631.ts.net:8443';

export const DEFAULT_CENTRE = { lat: -27.4433, lon: 152.9615 };

export function newCourse(id, name, pars = Array(18).fill(4), centre = null, si = []) {
  return {
    id,
    name,
    centre,
    tee: '',        // tee set played, e.g. "White"
    rating: null,   // course (scratch) rating for that tee
    slope: null,    // slope rating for that tee
    holes: pars.map((par, i) => ({ n: i + 1, par, si: si[i] ?? null, green: null, front: null, back: null, tee: null })),
    createdAt: new Date().toISOString(),
  };
}
