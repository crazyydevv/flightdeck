// POST /api/crew : asks the configured model to argue against a preflight
// report. The model receives the report's numbers and nothing else, and its
// reply cannot change the verdict or the Tower's decision.
import type { ServerResponse } from 'node:http';
import { crewPrompt, parseCrewReply } from '../src/core/crew';
import { chat, llmConfigured } from '../src/core/llm';
import { PreflightReport } from '../src/core/types';
import { Req, readJson, send } from './_http';

export default async function handler(req: Req, res: ServerResponse) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!llmConfigured()) return send(res, 501, { error: 'not_configured' });
  try {
    const { report, base: instrument } = await readJson<{ report: PreflightReport; base: string }>(req);
    const prompt = crewPrompt(report, String(instrument).slice(0, 12));
    const briefs = parseCrewReply((await chat(prompt.system, prompt.user)) ?? '');
    if (!briefs) return send(res, 502, { error: 'bad_model_reply' });
    send(res, 200, { briefs, model: process.env.LLM_MODEL });
  } catch (e) {
    send(res, 502, { error: 'model_unreachable', message: (e as Error).message });
  }
}
