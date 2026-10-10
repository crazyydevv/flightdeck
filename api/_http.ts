import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = IncomingMessage & { body?: unknown };

export function send(res: ServerResponse, status: number, data: unknown, cache = 'no-store'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(data));
}

/** Works on Vercel and Netlify (body already parsed) and on a bare Node server (stream). */
export async function readJson<T>(req: Req): Promise<T> {
  if (req.body !== undefined) return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as T;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

export const query = (req: Req) => new URL(req.url ?? '/', 'http://x').searchParams;

export const validDeck = (deck: unknown): deck is string => typeof deck === 'string' && /^[a-z0-9]{6,24}$/.test(deck);

/**
 * Writes are open by default so a demo works with no setup. Set
 * FLIGHTDECK_OPERATOR_KEY and every write must carry it in x-operator-key.
 */
export function operatorOk(req: Req): boolean {
  const key = process.env.FLIGHTDECK_OPERATOR_KEY;
  return !key || req.headers['x-operator-key'] === key;
}
