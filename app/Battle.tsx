'use client';

import { useEffect, useState } from 'react';
import { callBattle, describeError, isError, type ClientErrorCode } from '@/lib/client/api';
import { buildContextPayload, getPlayerKey, resetPlayer } from '@/lib/client/context';
import type { ArchetypeMode, ContextPayload, GenerateResult, JudgeResult } from '@/lib/types';

export interface RosterOption {
  id: string;
  label: string;
  targetingValue: string;
}
export interface CriterionOption {
  id: string;
  label: string;
  max: number;
}

// pick -> topic -> generating -> respond -> judging -> result
// Each LLM step can land in `generate-error` / `judge-error` (retryable) instead.
type Phase = 'pick' | 'topic' | 'generating' | 'generate-error' | 'respond' | 'judging' | 'judge-error' | 'result';

const ASSIGN = '__assign__';

export default function Battle({ roster, criteria }: { roster: RosterOption[]; criteria: CriterionOption[] }) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [playerKey, setPlayerKey] = useState('');
  const [selection, setSelection] = useState<string>(ASSIGN);
  const [topic, setTopic] = useState('');
  const [roundId, setRoundId] = useState('');
  const [generated, setGenerated] = useState<GenerateResult | null>(null);
  const [humanVerse, setHumanVerse] = useState('');
  const [result, setResult] = useState<JudgeResult | null>(null);
  const [error, setError] = useState<ClientErrorCode | null>(null);
  const [lastContext, setLastContext] = useState<ContextPayload | null>(null);

  useEffect(() => setPlayerKey(getPlayerKey()), []);

  const mode: ArchetypeMode = selection === ASSIGN ? 'assigned' : 'picked';
  const context = () => {
    const payload = buildContextPayload(mode, mode === 'picked' ? selection : undefined);
    setLastContext(payload);
    return payload;
  };

  function newRound(keepArchetype = true) {
    setTopic('');
    setRoundId('');
    setGenerated(null);
    setHumanVerse('');
    setResult(null);
    setError(null);
    setPhase(keepArchetype ? 'topic' : 'pick');
  }

  // Start: mint the roundId once per round. A retry after a failed generate reuses it, so the round
  // stays one round, and the same id goes with both calls.
  async function generate() {
    const id = roundId || crypto.randomUUID();
    setRoundId(id);
    setError(null);
    setPhase('generating');
    const res = await callBattle<GenerateResult>({ type: 'generate', roundId: id, input: { topic }, context: context() });
    if (isError(res)) {
      setError(res.error);
      setPhase('generate-error');
      return;
    }
    setGenerated(res);
    setPhase('respond');
  }

  async function judge() {
    if (!generated || result) return; // browser half of the per-round dedupe
    setError(null);
    setPhase('judging');
    const res = await callBattle<JudgeResult>({
      type: 'judge',
      roundId,
      input: { topic, archetypeId: generated.archetypeId, archetypeVerse: generated.verse, humanVerse },
      context: context(),
    });
    if (isError(res)) {
      setError(res.error);
      setPhase('judge-error');
      return;
    }
    setResult(res);
    setPhase('result');
  }

  const opponentLabel = generated?.archetypeLabel ?? roster.find((a) => a.targetingValue === selection)?.label ?? 'LaunchDarkly picks';
  const err = error ? describeError(phase === 'judge-error' ? 'judge' : 'generate', error) : null;

  return (
    <main>
      <h1>Archetype Rap Battle</h1>
      <p>
        Player <code>{playerKey}</code>{' '}
        <button
          onClick={() => {
            setPlayerKey(resetPlayer());
            newRound(false);
          }}
        >
          New player
        </button>
      </p>

      {phase === 'pick' && (
        <section>
          <h2>1. Choose your opponent</h2>
          <select value={selection} onChange={(e) => setSelection(e.target.value)}>
            <option value={ASSIGN}>Let LaunchDarkly assign one</option>
            {roster.map((a) => (
              <option key={a.id} value={a.targetingValue}>
                {a.label}
              </option>
            ))}
          </select>{' '}
          <button onClick={() => setPhase('topic')}>Continue</button>
        </section>
      )}

      {(phase === 'topic' || phase === 'generating' || phase === 'generate-error') && (
        <section>
          <h2>2. Pick a topic</h2>
          <p>
            Opponent: <strong>{opponentLabel}</strong>{' '}
            <button disabled={phase === 'generating'} onClick={() => newRound(false)}>
              Change
            </button>
          </p>
          <input
            value={topic}
            maxLength={200}
            placeholder="e.g. Monday mornings"
            disabled={phase === 'generating'}
            onChange={(e) => setTopic(e.target.value)}
          />{' '}
          <button disabled={!topic.trim() || phase === 'generating'} onClick={generate}>
            {phase === 'generating' ? 'Writing a verse…' : phase === 'generate-error' ? 'Retry' : 'Start battle'}
          </button>
          {phase === 'generate-error' && err && <Notice {...err} />}
        </section>
      )}

      {generated && (
        <section>
          <h2>3. {generated.archetypeLabel} opens</h2>
          <pre>{generated.verse}</pre>
        </section>
      )}

      {generated && (phase === 'respond' || phase === 'judging' || phase === 'judge-error') && (
        <section>
          <h2>4. Your comeback</h2>
          <textarea
            rows={6}
            cols={60}
            maxLength={1200}
            value={humanVerse}
            disabled={phase === 'judging' || (phase === 'judge-error' && !!err?.onBreak)}
            onChange={(e) => setHumanVerse(e.target.value)}
          />
          <br />
          {!(phase === 'judge-error' && err?.onBreak) && (
            <button disabled={!humanVerse.trim() || phase === 'judging'} onClick={judge}>
              {phase === 'judging' ? 'Judging…' : phase === 'judge-error' ? 'Retry judging' : 'Submit verse'}
            </button>
          )}
          {phase === 'judge-error' && err && (
            <>
              <Notice {...err} />
              {err.onBreak && <button onClick={() => newRound()}>New round</button>}
            </>
          )}
        </section>
      )}

      {phase === 'result' && result && generated && (
        <section>
          <h2>5. The verdict</h2>
          <p>
            <strong>
              {result.winner === 'human' ? 'You win!' : result.winner === 'archetype' ? `${generated.archetypeLabel} takes it.` : "It's a tie."}
            </strong>{' '}
            {result.verdict}
          </p>
          <table>
            <thead>
              <tr>
                <th />
                <th>{generated.archetypeLabel}</th>
                <th>You</th>
              </tr>
            </thead>
            <tbody>
              {criteria.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>
                    {result.scores.archetype[c.id]}/{c.max}
                  </td>
                  <td>
                    {result.scores.human[c.id]}/{c.max}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => newRound()}>New round, same opponent</button> <button onClick={() => newRound(false)}>New opponent</button>
        </section>
      )}

      <details>
        <summary>Under the hood</summary>
        <pre>
          {JSON.stringify(
            {
              phase,
              roundId: roundId || null,
              contextSent: lastContext,
              rapperVariation: generated?.variationKey ?? null,
              judgeVariation: result?.judgeVariationKey ?? null,
              outcomeEvent: result ? `${result.outcomeEvent}${result.duplicate ? ' (duplicate, not re-sent)' : ''}` : null,
              error,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </main>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div role="status">
      <p>
        <strong>{title}</strong>
      </p>
      <p>{body}</p>
    </div>
  );
}
