// A slow or flaky connection must not leave the deck stuck on the recording:
// failed attempts are retried, and only a missing server stops the retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOP, liveMissingNotice, retry } from '../src/ui/connect';

const noWait = async () => undefined;

test('a dropped request is retried until the answer arrives', async () => {
  let calls = 0;
  const out = await retry(async () => (++calls < 3 ? null : 'market'), [0, 2000, 5000], noWait);
  assert.equal(out, 'market');
  assert.equal(calls, 3);
});

test('a request that throws counts as a failed attempt, not a crash', async () => {
  let calls = 0;
  const out = await retry(async () => { if (++calls === 1) throw new Error('ERR_INTERNET_DISCONNECTED'); return 'market'; }, [0, 2000], noWait);
  assert.equal(out, 'market');
});

test('it gives up after the last attempt', async () => {
  let calls = 0;
  const out = await retry(async () => { calls++; return null; }, [0, 2000, 5000], noWait);
  assert.equal(out, null);
  assert.equal(calls, 3);
});

test('no server stops the retries at once', async () => {
  let calls = 0;
  const out = await retry(async () => { calls++; return STOP; }, [0, 2000, 5000], noWait);
  assert.equal(out, null);
  assert.equal(calls, 1);
});

test('the waits between attempts are the ones asked for', async () => {
  const waited: number[] = [];
  await retry(async () => null, [0, 2000, 5000], async (ms) => { waited.push(ms); });
  assert.deepEqual(waited, [2000, 5000]);
});

test('a visitor on a bad connection is not told to deploy a server', () => {
  assert.doesNotMatch(liveMissingNotice(false), /deploy|npm/i);
  assert.match(liveMissingNotice(false), /keeps trying/);
  assert.match(liveMissingNotice(true), /npm run dev/);
});
