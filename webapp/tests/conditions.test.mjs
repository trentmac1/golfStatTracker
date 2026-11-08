import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionParts, setCondition } from '../js/conditions.js';

test('condition text and toggling', () => {
  const r = {};
  assert.deepEqual(conditionParts(r), []);
  setCondition(r, 'weather', 'rain'); setCondition(r, 'wind', 'strong'); setCondition(r, 'greens', 'fast');
  assert.deepEqual(conditionParts(r), ['Raining', 'Strong wind', 'Fast greens']);
  setCondition(r, 'wind', 'calm');
  assert.deepEqual(conditionParts(r), ['Raining', 'Calm', 'Fast greens']);
  setCondition(r, 'weather', 'rain');
  assert.equal(r.conditions.weather, undefined);
  assert.equal(conditionParts({ conditions: { weather: 'bogus' } }).length, 0);
});
