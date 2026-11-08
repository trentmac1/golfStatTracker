// Round conditions: weather, wind and green speed, saved on the round as
// round.conditions = { weather, wind, greens }. Each is optional.
export const CONDITIONS = [
  { key: 'weather', label: 'Weather', options: [['hot', 'Hot'], ['normal', 'Normal'], ['cold', 'Cold'], ['rain', 'Raining']] },
  { key: 'wind', label: 'Wind', options: [['calm', 'Calm'], ['light', 'Light'], ['breezy', 'Breezy'], ['strong', 'Strong']] },
  { key: 'greens', label: 'Greens', options: [['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast']] },
];

const label = (key, v) => CONDITIONS.find((c) => c.key === key)?.options.find(([k]) => k === v)?.[1] ?? null;

// Short text parts for a round, in a fixed order: ['Hot', 'Breezy', 'Fast greens'].
export function conditionParts(round) {
  const c = round?.conditions ?? {};
  const out = [];
  if (label('weather', c.weather)) out.push(label('weather', c.weather));
  if (label('wind', c.wind)) out.push(c.wind === 'calm' || c.wind === 'breezy' ? label('wind', c.wind) : `${label('wind', c.wind)} wind`);
  if (label('greens', c.greens)) out.push(`${label('greens', c.greens)} greens`);
  return out;
}

// Set one condition, or clear it when the same option is chosen again.
export function setCondition(round, key, value) {
  const c = { ...(round.conditions ?? {}) };
  if (c[key] === value) delete c[key]; else c[key] = value;
  round.conditions = c;
  return round;
}
