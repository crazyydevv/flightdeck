// A shared pass must draw for every symbol a deck can trade, not only the
// recorded eight: live-only symbols such as GOOGL get display terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instFor, isLiveTime, PUBLIC_DECK, RECORDING_END } from '../src/ui/public';

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

test('entries and trades are told apart by the recording clock', () => {
  // real entries from the public deck: #25 was flown on the recording, #19 and #21 on Live
  assert.equal(isLiveTime(1791482400000), false);
  assert.equal(isLiveTime(1791846000000), true);
  assert.equal(isLiveTime(1791909884509), true);
  assert.equal(isLiveTime(RECORDING_END), false);
});
