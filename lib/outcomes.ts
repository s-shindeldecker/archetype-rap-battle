import type { LDClient, LDContext } from '@launchdarkly/node-server-sdk';
import type { Winner } from './types';

/**
 * One custom event per possible outcome, ties included. Each event key is also the key of an LD
 * metric with the same name (see README). The app and scripts/seed.ts both track through here, so
 * live and pre-seeded rounds land in the same metrics.
 */
export const OUTCOME_EVENTS: Record<Winner, string> = {
  archetype: 'archetype-win',
  human: 'human-win',
  tie: 'tie',
};

export interface OutcomeData {
  roundId: string;
  archetypeId: string;
  rapperVariationKey: string;
  judgeVariationKey: string;
  eventSource: string;
}

export function trackOutcome(ld: LDClient, context: LDContext, winner: Winner, data: OutcomeData): string {
  const eventKey = OUTCOME_EVENTS[winner];
  ld.track(eventKey, context, data, 1);
  return eventKey;
}
