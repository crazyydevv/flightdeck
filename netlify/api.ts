// Netlify entry point. Netlify does not run the Vercel-style files in api/
// directly, so this one function receives every /api/* request (see the
// redirect in netlify.toml) and hands it to the same nine handlers, unchanged.
// The build bundles this file to dist/netlify/functions/api.js.

import type { ServerResponse } from 'node:http';
import type { Req } from '../api/_http';
import crew from '../api/crew';
import flights from '../api/flights';
import history from '../api/history';
import ledger from '../api/ledger';
import market from '../api/market';
import order from '../api/order';
import pass from '../api/pass';
import status from '../api/status';
import watch from '../api/watch';

type Handler = (req: Req, res: ServerResponse) => unknown;
const ROUTES: Record<string, Handler> = { crew, flights, history, ledger, market, order, pass, status, watch };

/** The parts of a Netlify (Lambda-style) event this adapter reads. */
export interface NetlifyEvent {
  httpMethod: string;
  path: string;
  rawQuery?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}
export interface NetlifyResult { statusCode: number; headers: Record<string, string>; body: string }

const json = (statusCode: number, data: unknown): NetlifyResult => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(data),
});

export async function handler(event: NetlifyEvent): Promise<NetlifyResult> {
  // works for /api/market and for /.netlify/functions/api/market
  const name = (event.path || '').replace(/\/+$/, '').split('/').pop() ?? '';
  const route = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : undefined;
  if (!route) return json(404, { error: 'not_found' });

  const pairs = Object.entries(event.queryStringParameters ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string');
  const qs = event.rawQuery ?? new URLSearchParams(pairs).toString();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
  const method = (event.httpMethod || 'GET').toUpperCase();
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  const req = { method, url: `/api/${name}${qs ? `?${qs}` : ''}`, headers, body: method === 'GET' || method === 'HEAD' ? undefined : raw || '{}' };

  return new Promise<NetlifyResult>((resolve) => {
    const out = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: unknown) { out.headers[k] = String(v); return out; },
      getHeader(k: string) { return out.headers[k]; },
      writeHead(code: number, h?: Record<string, unknown>) { out.statusCode = code; for (const [k, v] of Object.entries(h ?? {})) out.headers[k] = String(v); return out; },
      end(text?: string | Uint8Array) {
        resolve({ statusCode: out.statusCode, headers: out.headers, body: typeof text === 'string' ? text : text ? Buffer.from(text).toString('utf8') : '' });
      },
    };
    Promise.resolve()
      .then(() => route(req as unknown as Req, out as unknown as ServerResponse))
      .catch((e: unknown) => resolve(json(500, { error: 'function_failed', message: e instanceof Error ? e.message : String(e) })));
  });
}
