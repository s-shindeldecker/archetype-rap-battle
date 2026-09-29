import { NextResponse } from 'next/server';
import { handleGenerate, handleJudge } from '@/lib/server/battle';
import { getClients, type Clients } from '@/lib/server/clients';
import { buildLdContext } from '@/lib/server/context';
import { BattleError } from '@/lib/server/errors';
import type { BattleRequest, ErrorCode } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single dispatcher, same contract as the reference app's post_ai_config. It always returns HTTP 200.
 * Failures come back as `{ error: <code> }` so the browser can pick its fallback UI, and LD events are
 * flushed on every path (success or error), which serverless needs.
 */
export async function POST(request: Request) {
  let clients: Clients | undefined;
  let body: BattleRequest;
  try {
    body = (await request.json()) as BattleRequest;
  } catch {
    return reply({ error: 'bad_request' });
  }

  try {
    if (typeof body.roundId !== 'string' || !ROUND_ID.test(body.roundId)) {
      throw new BattleError('bad_request', 'roundId must be a UUID');
    }
    const context = buildLdContext(body.context);
    clients = await getClients();

    switch (body.type) {
      case 'generate':
        return reply(await handleGenerate(clients, context, body));
      case 'judge':
        return reply(await handleJudge(clients, context, body));
      default:
        throw new BattleError('bad_request', `unknown type "${(body as { type?: string }).type}"`);
    }
  } catch (err) {
    const code: ErrorCode = err instanceof BattleError ? err.code : 'config_error';
    const log = err instanceof BattleError ? console.warn : console.error;
    log(`[battle] ${body.type ?? '?'} round=${body.roundId ?? '?'} -> ${code}:`, err instanceof Error ? err.message : err);
    return reply({ error: code });
  } finally {
    if (clients) await clients.ld.flush().catch((e) => console.error('[battle] LD flush failed', e));
  }
}

function reply(payload: unknown) {
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}
