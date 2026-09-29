import type { JudgeResult } from '@/lib/types';

/**
 * In-process round ledger. It's keyed by `${contextKey}:${roundId}` so one player can't collide with
 * another's roundId.
 *
 * - `generated` keeps the server's own copy of the AI verse, so the judge scores what the model actually
 *   said, not whatever the browser echoes back.
 * - `judged` is the outcome-event dedupe: once a round has fired its win/loss/tie event, a resubmit
 *   gets the cached result with `duplicate: true` and no second LLM call or event.
 * - `judging` blocks a double-click from running two judge calls concurrently.
 *
 * Scope: one Node process. For `next start` or a single dev server that's complete. On multi-instance
 * serverless a resubmit can land on a cold instance with no ledger; the browser guard
 * (Submit is disabled once a result exists) is the second line of defense. See the README.
 */
interface RoundEntry {
  createdAt: number;
  archetypeId?: string;
  verse?: string;
  judging?: boolean;
  judged?: JudgeResult;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const g = globalThis as unknown as { __battleRounds?: Map<string, RoundEntry> };
const rounds = (g.__battleRounds ??= new Map());

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of rounds) {
    if (entry.createdAt < cutoff || rounds.size > MAX_ENTRIES) rounds.delete(id);
    else break; // Map iterates in insertion order, oldest first
  }
}

const id = (contextKey: string, roundId: string) => `${contextKey}:${roundId}`;

export function recordGenerated(contextKey: string, roundId: string, archetypeId: string, verse: string) {
  prune();
  // A new generate for the same roundId (user retried after an error) replaces the verse. It never
  // resurrects a judged round.
  const existing = rounds.get(id(contextKey, roundId));
  if (existing?.judged) return;
  rounds.set(id(contextKey, roundId), { createdAt: Date.now(), archetypeId, verse });
}

export function getGenerated(contextKey: string, roundId: string) {
  return rounds.get(id(contextKey, roundId));
}

/** Returns the cached result if already judged, `'busy'` if a judge call is in flight, else claims the round. */
export function claimForJudging(contextKey: string, roundId: string): JudgeResult | 'busy' | 'claimed' {
  const key = id(contextKey, roundId);
  const entry = rounds.get(key) ?? { createdAt: Date.now() };
  if (entry.judged) return entry.judged;
  if (entry.judging) return 'busy';
  entry.judging = true;
  rounds.set(key, entry);
  return 'claimed';
}

/** Releases the claim without recording an outcome, so a failed judge call can be retried. */
export function releaseClaim(contextKey: string, roundId: string) {
  const entry = rounds.get(id(contextKey, roundId));
  if (entry) entry.judging = false;
}

export function recordJudged(contextKey: string, roundId: string, result: JudgeResult) {
  const entry = rounds.get(id(contextKey, roundId)) ?? { createdAt: Date.now() };
  entry.judging = false;
  entry.judged = result;
  rounds.set(id(contextKey, roundId), entry);
}
