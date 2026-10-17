// A shared pass must draw for every symbol a deck can trade, not only the
// recorded eight: live-only symbols such as GOOGL get display terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instFor, PUBLIC_DECK } from '../src/ui/public';

test('recorded symbols keep their real terms', () => {
  const i = instFor('NVDAUSDT');
  assert.equal(i.base, 'NVDA');
  assert.equal(i.maxLever, 100);
});

test('live-only symbols get display terms', () => {
  const i = instFor('GOOGLUSDT');
  assert.equal(i.base, 'GOOGL');
  assert.equal(i.name, 'Alphabet');
  assert.equal(i.pricePlace, 2);
});

test('an unknown symbol still draws', () => {
  assert.equal(instFor('XYZUSDT').base, 'XYZ');
});

test('the public deck id is a valid deck id', () => {
  assert.match(PUBLIC_DECK, /^[a-z0-9]{6,24}$/);
});
