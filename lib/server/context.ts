import type { LDContext } from '@launchdarkly/node-server-sdk';
import { findByTargetingValue } from '@/lib/roster';
import type { ContextPayload, EventSource } from '@/lib/types';
import { BattleError } from './errors';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Rebuilds the LD context from what the browser forwarded. Only known attributes are kept.
 * `eventSource` is always set here on the server. API traffic is `live-demo`; only scripts/seed.ts sends
 * `pre-seeded`. Unlike the reference app there's no shared "demo-user" fallback: a missing key is
 * rejected, so contexts can't all collapse into one rollout bucket.
 */
export function buildLdContext(payload: ContextPayload | undefined, eventSource: EventSource = 'live-demo'): LDContext {
  if (!payload || typeof payload.key !== 'string' || !KEY_PATTERN.test(payload.key)) {
    throw new BattleError('bad_request', 'context.key missing or malformed');
  }
  const sessionId = typeof payload.sessionId === 'string' && KEY_PATTERN.test(payload.sessionId) ? payload.sessionId : undefined;
  const mode = payload.archetypeMode === 'picked' ? 'picked' : 'assigned';

  const context: LDContext = {
    kind: 'user',
    key: payload.key,
    archetypeMode: mode,
    eventSource,
  };
  if (sessionId) context.sessionId = sessionId;

  if (mode === 'picked') {
    const archetype = findByTargetingValue(payload.archetype);
    if (!archetype) throw new BattleError('bad_request', `unknown archetype "${payload.archetype}"`);
    context.archetype = archetype.targetingValue;
  }
  return context;
}
