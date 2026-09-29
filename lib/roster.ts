import rosterFile from '@/config/archetypes.json';
import judgeFile from '@/config/judge.json';

export interface Archetype {
  id: string;
  label: string;
  /** Sent as the `archetype` context attribute; LD targeting rules match on it. */
  targetingValue: string;
  /** Key of the archetype-rapper-config variation holding this persona. Maps a served variation back to an archetype. */
  variationKey: string;
  persona: { ref: string; prompt: string };
  /** Only read by scripts/seed.ts. */
  seed?: { archetypeWinRate?: number; tieRate?: number };
}

export interface JudgeCriterion {
  id: string;
  label: string;
  max: number;
}

export const ARCHETYPES: Archetype[] = rosterFile.archetypes;
export const JUDGE_CRITERIA: JudgeCriterion[] = judgeFile.criteria;
export const JUDGE_RUBRIC: string = judgeFile.rubric;

export function findByTargetingValue(value: string | undefined): Archetype | undefined {
  return value ? ARCHETYPES.find((a) => a.targetingValue === value) : undefined;
}

export function findByVariationKey(key: string | undefined): Archetype | undefined {
  return key ? ARCHETYPES.find((a) => a.variationKey === key) : undefined;
}
