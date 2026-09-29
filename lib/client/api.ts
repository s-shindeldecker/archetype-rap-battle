'use client';

import type { BattleRequest, ErrorCode } from '@/lib/types';

/** Browser-side errors in addition to the server's codes. */
export type ClientErrorCode = ErrorCode | 'request_timeout' | 'network_error';

// Longer than the server's OpenAI timeout (20s default) plus LD evaluation, so a server-side timeout
// arrives as `llm_timeout` rather than being cut off here. Still short enough that nothing hangs on stage.
const FETCH_TIMEOUT_MS = 30_000;

export async function callBattle<T>(body: BattleRequest): Promise<T | { error: ClientErrorCode }> {
  try {
    const res = await fetch('/api/battle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: 'network_error' };
    return (await res.json()) as T | { error: ErrorCode };
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { error: 'request_timeout' };
    }
    return { error: 'network_error' };
  }
}

export function isError(value: unknown): value is { error: ClientErrorCode } {
  return !!value && typeof value === 'object' && 'error' in value;
}

/** Friendly copy for each failure. A kill switch (`config_disabled`) gets the "taking a break" state, never a raw code. */
export function describeError(step: 'generate' | 'judge', code: ClientErrorCode): { title: string; body: string; onBreak: boolean } {
  if (code === 'config_disabled' || code === 'model_unavailable' || code === 'provider_unavailable' || code === 'config_unavailable') {
    return step === 'generate'
      ? {
          onBreak: true,
          title: 'The archetype battle is taking a break',
          body: 'Our rappers are backstage right now. Grab a coffee and check back in a minute.',
        }
      : {
          onBreak: true,
          title: 'The judge has stepped out',
          body: "Both verses are below. Call this one yourselves: no score and no winner recorded this round.",
        };
  }
  if (code === 'llm_timeout' || code === 'request_timeout') {
    return {
      onBreak: false,
      title: step === 'generate' ? 'Your opponent missed their cue' : 'The judge is still deliberating',
      body: 'That took too long, so we stopped waiting. Hit retry.',
    };
  }
  if (code === 'round_in_progress') {
    return { onBreak: false, title: 'Already judging', body: 'This round is being scored. Give it a second.' };
  }
  return {
    onBreak: false,
    title: step === 'generate' ? 'Your opponent fumbled the mic' : 'The judge lost their scorecard',
    body: 'Something went wrong on our side. Hit retry.',
  };
}
