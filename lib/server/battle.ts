import type { LDContext } from '@launchdarkly/node-server-sdk';
import { trackOutcome } from '@/lib/outcomes';
import { ARCHETYPES, findByTargetingValue, findByVariationKey, JUDGE_CRITERIA, JUDGE_RUBRIC, type Archetype } from '@/lib/roster';
import type { GenerateRequest, GenerateResult, JudgeRequest, JudgeResult, ScoreCard, Winner } from '@/lib/types';
import { JUDGE_CONFIG_KEY, RAPPER_CONFIG_KEY, type Clients } from './clients';
import { BattleError } from './errors';
import { invokeAgent } from './invoke';
import { safeParseJson } from './json';
import { claimForJudging, getGenerated, recordGenerated, recordJudged, releaseClaim } from './rounds';

const MAX_TOPIC = 200;
const MAX_VERSE = 1200;

const VERSE_CONTRACT = 'Respond with raw JSON only, no code fences: {"verse": "<4-8 lines separated by \\n>"}';

function judgeContract(): string {
  const card = JUDGE_CRITERIA.map((c) => `"${c.id}": <0-${c.max}>`).join(', ');
  return (
    'Respond with raw JSON only, no code fences: ' +
    `{"scores": {"archetype": {${card}}, "human": {${card}}}, ` +
    '"winner": "archetype" | "human" | "tie", "verdict": "<one line>"}'
  );
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new BattleError('bad_request', `${field} is required`);
  if (value.length > max) throw new BattleError('bad_request', `${field} exceeds ${max} characters`);
  return value.trim();
}

function personaVariables(archetype: Archetype) {
  return {
    archetype: archetype.id,
    archetype_label: archetype.label,
    persona: archetype.persona.prompt,
  };
}

// ---------------------------------------------------------------------------------------------
// LLM call #1: the archetype writes an opening verse.

export async function handleGenerate(clients: Clients, context: LDContext, req: GenerateRequest): Promise<GenerateResult> {
  const topic = requireText(req.input?.topic, 'topic', MAX_TOPIC);
  const picked = findByTargetingValue((context as { archetype?: string }).archetype);

  let served: Archetype | undefined;
  const result = await invokeAgent(
    clients,
    RAPPER_CONFIG_KEY,
    context,
    (variationKey) => {
      // Picked mode: a targeting rule on `archetype` should have served this archetype's variation.
      // Assigned mode: LD chose the variation (the experiment arm), so derive the archetype from it.
      served = findByVariationKey(variationKey) ?? picked;
      if (!served) {
        throw new BattleError('unknown_archetype', `variation "${variationKey}" has no roster entry; known: ${ARCHETYPES.map((a) => a.variationKey).join(', ')}`);
      }
      if (picked && served.id !== picked.id) {
        console.warn(`[battle] picked ${picked.id} but ${RAPPER_CONFIG_KEY} served "${variationKey}". Check the targeting rules.`);
      }
      return { ...personaVariables(served), topic };
    },
    `Topic: ${topic}\n\n${VERSE_CONTRACT}`,
  );

  const parsed = safeParseJson(result.content);
  const verse = typeof parsed?.verse === 'string' ? parsed.verse.replace(/\\n/g, '\n').trim() : '';
  if (!verse) throw new BattleError('invalid_verse', `unparseable verse from ${result.variationKey}`);

  recordGenerated(String(context.key), req.roundId, served!.id, verse);
  return {
    roundId: req.roundId,
    archetypeId: served!.id,
    archetypeLabel: served!.label,
    variationKey: result.variationKey,
    verse,
  };
}

// ---------------------------------------------------------------------------------------------
// LLM call #2: the judge scores both verses. It fires exactly one outcome event per roundId.

function parseScoreCard(raw: unknown): ScoreCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const card: ScoreCard = {};
  for (const c of JUDGE_CRITERIA) {
    const v = Number((raw as Record<string, unknown>)[c.id]);
    if (!Number.isFinite(v)) return null;
    card[c.id] = Math.max(0, Math.min(c.max, Math.round(v)));
  }
  return card;
}

function parseWinner(raw: unknown): Winner | null {
  const w = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (w === 'archetype' || w === 'ai') return 'archetype';
  if (w === 'human' || w === 'player' || w === 'user') return 'human';
  if (w === 'tie' || w === 'draw') return 'tie';
  return null;
}

export async function handleJudge(clients: Clients, context: LDContext, req: JudgeRequest): Promise<JudgeResult> {
  const contextKey = String(context.key);
  const topic = requireText(req.input?.topic, 'topic', MAX_TOPIC);
  const humanVerse = requireText(req.input?.humanVerse, 'humanVerse', MAX_VERSE);

  // Prefer the server's copy of the AI verse and archetype. Fall back to the browser's echo only when
  // this process never saw the generate call (another serverless instance, or a restart).
  const generated = getGenerated(contextKey, req.roundId);
  const archetypeVerse = generated?.verse ?? requireText(req.input?.archetypeVerse, 'archetypeVerse', MAX_VERSE);
  const archetype = ARCHETYPES.find((a) => a.id === (generated?.archetypeId ?? req.input?.archetypeId));
  if (!archetype) throw new BattleError('bad_request', 'archetypeId does not match the roster');

  const claim = claimForJudging(contextKey, req.roundId);
  if (claim === 'busy') throw new BattleError('round_in_progress');
  if (claim !== 'claimed') return { ...claim, duplicate: true };

  try {
    const result = await invokeAgent(
      clients,
      JUDGE_CONFIG_KEY,
      context,
      {
        rubric: JUDGE_RUBRIC,
        criteria: JUDGE_CRITERIA.map((c) => `${c.label} (0-${c.max})`).join(', '),
        archetype_label: archetype.label,
        topic,
      },
      [
        `Topic: ${topic}`,
        `Archetype (${archetype.label}) verse:\n${archetypeVerse}`,
        `Human verse:\n${humanVerse}`,
        judgeContract(),
      ].join('\n\n'),
    );

    const parsed = safeParseJson(result.content);
    const scores = parsed?.scores as Record<string, unknown> | undefined;
    const archetypeCard = parseScoreCard(scores?.archetype ?? scores?.ai);
    const humanCard = parseScoreCard(scores?.human);
    const winner = parseWinner(parsed?.winner);
    const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.trim() : '';
    if (!archetypeCard || !humanCard || !winner || !verdict) {
      throw new BattleError('invalid_judge', `unparseable judge output from ${result.variationKey}`);
    }

    // Outcome events are tracked only after a fully valid parse. A bad judge response fires nothing,
    // so the round stays retryable and never skews the experiment.
    const rapperVariationKey = archetype.variationKey;
    const outcomeEvent = trackOutcome(clients.ld, context, winner, {
      roundId: req.roundId,
      archetypeId: archetype.id,
      rapperVariationKey,
      judgeVariationKey: result.variationKey,
      eventSource: String((context as { eventSource?: string }).eventSource),
    });

    const judged: JudgeResult = {
      roundId: req.roundId,
      winner,
      verdict,
      scores: { archetype: archetypeCard, human: humanCard },
      judgeVariationKey: result.variationKey,
      outcomeEvent,
      duplicate: false,
    };
    recordJudged(contextKey, req.roundId, judged);
    return judged;
  } catch (err) {
    releaseClaim(contextKey, req.roundId);
    throw err;
  }
}
