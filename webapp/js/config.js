// Defaults and the seeded home course.
export const APP_VERSION = '0.1.0';

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
};

// Fallback map centre when nothing else is known (Brisbane).
export const DEFAULT_CENTRE = { lat: -27.4433, lon: 152.9615 };

export function newCourse(id, name, pars = Array(18).fill(4), centre = null) {
  return {
    id,
    name,
    centre,
    holes: pars.map((par, i) => ({ n: i + 1, par, green: null, front: null, back: null, tee: null })),
    createdAt: new Date().toISOString(),
  };
}
