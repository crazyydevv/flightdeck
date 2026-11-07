// Reaching the live server from a slow or flaky connection.
// The live market is a large answer (every contract with its hourly candles), so one
// dropped request at page load must not leave the deck stuck on the recording.

/** An attempt returns a value, null to try again, or STOP when retrying cannot help. */
export const STOP = Symbol('stop');

/** Waits between attempts: try now, then after 2 s, then after 5 s. */
export const RETRY_DELAYS = [0, 2_000, 5_000];

/** While live data is missing, the deck tries again this often in the background. */
export const BACKGROUND_RETRY_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retry<T>(
  attempt: () => Promise<T | null | typeof STOP>,
  delays: number[] = RETRY_DELAYS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T | null> {
  for (const d of delays) {
    if (d > 0) await wait(d);
    const out = await attempt().catch(() => null);
    if (out === STOP) return null;
    if (out !== null) return out;
  }
  return null;
}

/** What the deck says when Live is pressed and live data has not arrived. */
export function liveMissingNotice(noServer: boolean): string {
  return noServer
    ? 'No live server answered. Deploy with the /api routes, or run npm run dev, to fly on live Bitget data.'
    : 'Live Bitget data did not load on this connection. FLIGHTDECK keeps trying in the background; press Live again in a moment. The recorded feed works offline.';
}
