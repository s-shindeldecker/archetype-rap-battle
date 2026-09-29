/**
 * Offline self-test of the round mechanics. No LD or OpenAI keys needed: LD's TestData source stands in
 * for both AI Configs and a stub stands in for OpenAI. It checks variation serving (picked vs assigned),
 * template interpolation, JSON hardening, one-event-per-round dedupe, tie tracking, timeout mapping, and
 * both kill switches.
 *
 *   npm run smoke
 */
import { init } from '@launchdarkly/node-server-sdk';
import { TestData } from '@launchdarkly/node-server-sdk/integrations';
import { initAi } from '@launchdarkly/server-sdk-ai';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { handleGenerate, handleJudge } from '../lib/server/battle';
import { buildLdContext } from '../lib/server/context';
import { BattleError } from '../lib/server/errors';
import { ARCHETYPES } from '../lib/roster';

const agent = (variationKey: string, instructions: string, enabled = true) => ({
  _ldMeta: { enabled, variationKey, version: 1, mode: 'agent' },
  ...(enabled ? { model: { name: 'gpt-4.1-mini', parameters: { temperature: 0.9, maxTokens: 200 } }, provider: { name: 'OpenAI' }, instructions } : {}),
});

const td = new TestData();
const rapperVariations = [...ARCHETYPES.map((a) => agent(a.variationKey, 'You are the {{archetype_label}}. Persona: {{persona}}. Topic {{topic}}. ctx={{ldctx.key}}')), agent('disabled', '', false)];
const rapper = td.flag('archetype-rapper-config').variations(...rapperVariations).fallthroughVariation(3);
ARCHETYPES.forEach((a, i) => rapper.ifMatch('archetype', a.targetingValue).thenReturn(i));
td.update(rapper);
td.update(td.flag('battle-judge-config').variations(agent('tough', 'Rubric: {{rubric}} | {{criteria}}'), agent('disabled', '', false)).fallthroughVariation(0));

const ld = init('sdk-fake', { updateProcessor: td.getFactory(), sendEvents: false });
await ld.waitForInitialization({ timeout: 5 });
const tracked: string[] = [];
const realTrack = ld.track.bind(ld);
ld.track = (k, c, d, v) => { if (!k.startsWith('$ld:')) tracked.push(k); return realTrack(k, c, d, v); };

const calls: any[] = [];
let nextReply = '';
let failNext: Error | null = null;
const openai = { chat: { completions: { create: async (body: any) => {
  calls.push(body);
  if (failNext) { const e = failNext; failNext = null; throw e; }
  return { choices: [{ message: { content: nextReply } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
} } } } as unknown as OpenAI;
const clients = { ld, ai: initAi(ld), openai };

const check = (label: string, ok: boolean, extra: unknown = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, extra); if (!ok) process.exitCode = 1; };
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof BattleError ? e.code : `THROW ${e}`; } };

// 1. picked wizard -> targeting rule serves wizard; persona interpolated; params mapped
const ctxP = buildLdContext({ key: 'player-1', sessionId: 's1', archetypeMode: 'picked', archetype: 'wizard' });
check('eventSource forced live-demo', (ctxP as { eventSource?: string }).eventSource === 'live-demo', ctxP);
const r1 = randomUUID();
nextReply = '```json\n{"verse": "line one\\nline two"}\n```';
const g1 = await handleGenerate(clients, ctxP, { type: 'generate', roundId: r1, input: { topic: 'tacos' }, context: {} as any });
check('picked -> wizard variation', g1.archetypeId === 'wizard' && g1.variationKey === 'wizard', g1);
check('code fence stripped, verse parsed', g1.verse === 'line one\nline two');
check('persona + ldctx interpolated in system msg', calls[0].messages[0].content.includes('Wizard') && calls[0].messages[0].content.includes('TODO(persona)') && calls[0].messages[0].content.includes('ctx=player-1'), calls[0].messages[0].content);
check('maxTokens -> max_completion_tokens', calls[0].max_completion_tokens === 200 && !('maxTokens' in calls[0]));

// 2. judge -> exactly one event; resubmit is deduped
nextReply = 'Here you go: {"scores":{"archetype":{"wordplay":7,"relevance":8,"humor":6},"human":{"wordplay":9,"relevance":8,"humor":9}},"winner":"human","verdict":"Crowd goes wild."}';
const jr = { type: 'judge' as const, roundId: r1, input: { topic: 'tacos', archetypeId: 'wizard', archetypeVerse: 'TAMPERED', humanVerse: 'my bars' }, context: {} as any };
const j1 = await handleJudge(clients, ctxP, jr);
check('judge winner human, event human-win', j1.winner === 'human' && j1.outcomeEvent === 'human-win' && !j1.duplicate, j1);
check('judge used server copy of AI verse, not tampered echo', calls[1].messages[1].content.includes('line one') && !calls[1].messages[1].content.includes('TAMPERED'));
const before = calls.length;
const j2 = await handleJudge(clients, ctxP, jr);
check('resubmit deduped: no LLM call, duplicate flag', j2.duplicate && calls.length === before);
check('exactly one outcome event so far', tracked.length === 1 && tracked[0] === 'human-win', tracked);

// 3. assigned mode -> fallthrough variation -> archetype derived from variation
const ctxA = buildLdContext({ key: 'player-2', sessionId: 's2', archetypeMode: 'assigned', archetype: 'cowboy' });
check('assigned mode drops archetype attr', !('archetype' in ctxA));
nextReply = '{"verse":"yo"}';
const g3 = await handleGenerate(clients, ctxA, { type: 'generate', roundId: randomUUID(), input: { topic: 'x' }, context: {} as any });
check('assigned -> fallthrough arm maps to roster', g3.archetypeId === ARCHETYPES[3].id, g3);

// 4. judge failure paths: invalid output -> no event, retry allowed; tie tracked
const r4 = randomUUID();
nextReply = '{"verse":"a"}';
await handleGenerate(clients, ctxP, { type: 'generate', roundId: r4, input: { topic: 't' }, context: {} as any });
nextReply = 'not json at all';
check('invalid judge -> invalid_judge', (await code(handleJudge(clients, ctxP, { ...jr, roundId: r4 }))) === 'invalid_judge');
check('no event fired on invalid judge', tracked.length === 1);
nextReply = '{"scores":{"ai":{"wordplay":5,"relevance":5,"humor":5},"human":{"wordplay":5,"relevance":5,"humor":5}},"winner":"draw","verdict":"Dead even."}';
const j4 = await handleJudge(clients, ctxP, { ...jr, roundId: r4 });
check('retry after failure works; tie tracked', j4.winner === 'tie' && tracked.at(-1) === 'tie', tracked);

// 5. timeout -> llm_timeout, no retry
failNext = new OpenAI.APIConnectionTimeoutError();
const n5 = calls.length;
check('timeout -> llm_timeout', (await code(handleGenerate(clients, ctxP, { type: 'generate', roundId: randomUUID(), input: { topic: 't' }, context: {} as any }))) === 'llm_timeout');
check('exactly one attempt (no auto-retry in our code)', calls.length === n5 + 1);

// 6. kill switch: rapper off -> config_disabled, no LLM call
td.update(rapper.on(false).offVariation(rapperVariations.length - 1));
const n6 = calls.length;
check('rapper off -> config_disabled', (await code(handleGenerate(clients, ctxP, { type: 'generate', roundId: randomUUID(), input: { topic: 't' }, context: {} as any }))) === 'config_disabled');
check('kill switch made no LLM call', calls.length === n6);
td.update(td.flag('battle-judge-config').on(false).offVariation(1));
const r7 = randomUUID();
td.update(rapper.on(true));
nextReply = '{"verse":"a"}';
await handleGenerate(clients, ctxP, { type: 'generate', roundId: r7, input: { topic: 't' }, context: {} as any });
check('judge off -> config_disabled', (await code(handleJudge(clients, ctxP, { ...jr, roundId: r7 }))) === 'config_disabled');

// 7. context validation
check('bad context key rejected', (await code(Promise.resolve().then(() => buildLdContext({ key: '', sessionId: '', archetypeMode: 'assigned' })))) === 'bad_request');
console.log('outcome events:', tracked);
ld.close();
