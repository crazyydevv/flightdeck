// GET /api/status : what this deployment is wired to.
import type { ServerResponse } from 'node:http';
import { credentialsFromEnv, tradingMode } from '../src/core/bitget';
import { llmConfigured } from '../src/core/llm';
import { storeFromEnv } from '../src/core/store';
import { Req, send } from './_http';

export default function handler(_req: Req, res: ServerResponse) {
  send(res, 200, {
    trading: credentialsFromEnv() ? tradingMode() : 'paper',
    crew: llmConfigured(),
    model: process.env.LLM_MODEL || null,
    storage: storeFromEnv()?.kind ?? null,
    locked: Boolean(process.env.FLIGHTDECK_OPERATOR_KEY),
  });
}
