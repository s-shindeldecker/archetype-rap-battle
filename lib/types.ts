// Wire contract shared by the browser and POST /api/battle.

export const EVENT_SOURCES = ['live-demo', 'pre-seeded'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** `picked`: the user chose an archetype (targeting rule on `archetype`). `assigned`: LD picks (experiment fallthrough). */
export type ArchetypeMode = 'picked' | 'assigned';

/** Context attributes the browser forwards. The server rebuilds and validates the LD context from these. */
export interface ContextPayload {
  key: string;
  sessionId: string;
  archetypeMode: ArchetypeMode;
  /** Roster `targetingValue`. Present only when archetypeMode is `picked`. */
  archetype?: string;
}

export type Winner = 'archetype' | 'human' | 'tie';

export interface GenerateRequest {
  type: 'generate';
  roundId: string;
  input: { topic: string };
  context: ContextPayload;
}

export interface JudgeRequest {
  type: 'judge';
  roundId: string;
  input: { topic: string; archetypeId: string; archetypeVerse: string; humanVerse: string };
  context: ContextPayload;
}

export type BattleRequest = GenerateRequest | JudgeRequest;

export interface GenerateResult {
  roundId: string;
  archetypeId: string;
  archetypeLabel: string;
  variationKey: string;
  verse: string;
}

export interface ScoreCard {
  [criterionId: string]: number;
}

export interface JudgeResult {
  roundId: string;
  winner: Winner;
  verdict: string;
  scores: { archetype: ScoreCard; human: ScoreCard };
  judgeVariationKey: string;
  /** Event key that was tracked for this round. */
  outcomeEvent: string;
  /** True when this roundId was already judged; the cached result is returned and no event fires. */
  duplicate: boolean;
}

export const ERROR_CODES = [
  'config_disabled', // AI Config served its off variation (the kill switch)
  'model_unavailable', // variation has no model
  'provider_unavailable', // provider isn't OpenAI
  'unknown_archetype', // served variation doesn't match a roster entry
  'invalid_verse', // generate output didn't parse
  'invalid_judge', // judge output didn't parse
  'llm_timeout',
  'round_in_progress', // judge already running for this roundId
  'bad_request',
  'config_unavailable', // SDK keys missing or LD didn't initialize
  'config_error', // anything else
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type BattleResponse<T> = T | { error: ErrorCode };
