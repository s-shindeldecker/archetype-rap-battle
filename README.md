# Archetype Rap Battle

A LaunchDarkly AI Configs demo for live conferences and customer onsites. The player faces an
opponent archetype (Cowboy, Astronaut, Wizard, and so on). The archetype opens with a verse on the
player's topic, the player types a comeback, and an AI judge scores both verses.

**A round is exactly two sequential LLM calls:**

1. `archetype-rapper-config` writes the opening verse, using the variation for the assigned archetype.
2. `battle-judge-config` scores both verses and returns a winner plus a one-line verdict.

There's no fallback agent, no quality gate, no agent graph, no re-judging, and no automatic retry.
If a call fails, the UI says so and the player hits Retry. This is deliberate: it keeps on-stage
latency predictable.

Stack: one Next.js 16 app (UI and API route), `@launchdarkly/node-server-sdk`,
`@launchdarkly/server-sdk-ai` v2, and `openai` (Chat Completions, called directly and wrapped with
the AI Config tracker).

## Quick start

```sh
npm install
cp .env.example .env.local        # add LAUNCHDARKLY_SDK_KEY and OPENAI_API_KEY
git config core.hooksPath .githooks   # once per clone: pre-commit secret scan
npm run dev                       # http://localhost:3000
```

`npm run smoke` runs an offline self-test with no keys. LD's `TestData` source stands in for both
configs and a stub stands in for OpenAI. It checks variation serving, interpolation, JSON hardening,
outcome dedupe, tie tracking, timeouts, and both kill switches.

| Env var | Required | Default |
|---|---|---|
| `LAUNCHDARKLY_SDK_KEY` | yes | Server-side SDK key for the environment that holds both AI Configs |
| `OPENAI_API_KEY` | yes | The model name comes from the AI Config variation |
| `LD_RAPPER_CONFIG_KEY` | no | `archetype-rapper-config` |
| `LD_JUDGE_CONFIG_KEY` | no | `battle-judge-config` |
| `OPENAI_TIMEOUT_MS` | no | `20000` |
| `LD_INIT_TIMEOUT_SECONDS` | no | `10` |

The app needs no client-side ID. All evaluation happens on the server; the browser only forwards
context attributes.

---

## Setting up LaunchDarkly

Create everything below in **one** project and environment, the one your SDK key belongs to.

### 1. `archetype-rapper-config` (AI Config, **agent** mode)

- **Provider:** OpenAI. The app rejects any other provider with `provider_unavailable`. Use any
  Chat Completions model (for example `gpt-4.1-mini`). Parameters such as `temperature` and
  `maxTokens` are passed through (`maxTokens` maps to `max_completion_tokens`).
- **One variation per archetype.** The variation **key** must equal that archetype's `variationKey`
  in [`config/archetypes.json`](config/archetypes.json) (`cowboy`, `astronaut`, …). That's how the
  app maps a served variation back to an archetype.
- **Instructions** can use these template variables, filled in by the app:

  | Variable | Value |
  |---|---|
  | `{{persona}}` | The roster entry's `persona.prompt` (currently a TODO placeholder) |
  | `{{archetype_label}}` | e.g. `Cowboy` |
  | `{{archetype}}` | e.g. `cowboy` |
  | `{{topic}}` | The player's topic |
  | `{{ldctx.*}}` | Any context attribute, e.g. `{{ldctx.eventSource}}` |

  You can write the persona directly in each variation's instructions, or keep it in the roster and
  reference `{{persona}}`. Either works.
- **Output contract:** you don't need to state one. The app's user message carries the topic and
  requires raw JSON `{"verse": "..."}`, which the app parses (code fences and surrounding prose are
  tolerated).
- **Off variation:** a variation that's disabled / has no model (LD's default `disabled`). This is
  the kill switch; see below.
- **Don't attach judges** (`judgeConfiguration`) to this config. The app never runs them, and a
  quality judge is out of scope.

**Targeting:**

| Where | Serve | Why |
|---|---|---|
| Rule per archetype: `archetype` **is one of** `cowboy` | variation `cowboy` | "Picked" mode: the player chose an opponent |
| … one rule per roster entry … | | |
| **Default rule (fallthrough)** | the **experiment**, a percentage rollout by `user` across the archetype variations | "Assigned" mode: LD picks the opponent |

### 2. `battle-judge-config` (AI Config, **agent** mode)

- Provider OpenAI, any Chat Completions model. A lower temperature (around 0.3–0.5) gives more
  consistent judging.
- **Instructions** template variables:

  | Variable | Value |
  |---|---|
  | `{{rubric}}` | `rubric` from [`config/judge.json`](config/judge.json) (**TODO placeholder**, write your rubric there or in the variation) |
  | `{{criteria}}` | e.g. `Wordplay (0-10), Relevance to the topic (0-10), Humor (0-10)` |
  | `{{archetype_label}}`, `{{topic}}` | as above |

- The user message the app sends contains the topic, both verses, and the required raw-JSON contract:
  `{"scores": {"archetype": {...}, "human": {...}}, "winner": "archetype"|"human"|"tie", "verdict": "..."}`.
  Criteria ids come from `config/judge.json`, so if you add a criterion there, it shows up in both the contract and the UI.
- The judge LLM decides the winner. The code does no scoring math; it only clamps each score to
  `0..max`.
- Off variation: disabled (the judge's kill switch).
- Targeting is up to you. For example, A/B two judging personas by `user`. It's independent of the
  archetype experiment.

### 3. Metrics: one per outcome, ties included

Create three **custom conversion (count)** metrics, randomization unit **user**, each with event key
equal to the metric key:

| Metric / event key | Fires when |
|---|---|
| `archetype-win` | the judge's winner is the archetype |
| `human-win` | the judge's winner is the player |
| `tie` | the judge calls a tie |

Exactly one of the three fires per judged round, and only after the judge output parses fully. A
failed or unparseable judge call fires nothing. Event data carries `roundId`, `archetypeId`,
`rapperVariationKey`, `judgeVariationKey`, and `eventSource`.

### 4. The experiment

Create an experiment on **`archetype-rapper-config`**:

- **Audience:** the default rule (fallthrough). Randomization unit: `user`.
- **Arms:** the archetype variations. Pick one as the control.
- **Metrics:** `archetype-win` (primary), `human-win`, `tie`.

The result is archetype win rate per arm as a real LD experiment result.

> **Picked vs. assigned.** An LD experiment runs on a single targeting rule. Rounds where the player
> *picked* an opponent hit the per-archetype rules, so they're **not experiment traffic**, though their
> outcome events still land in the metrics. Only "Let LaunchDarkly assign one" rounds, and all seeded
> rounds, feed the experiment. On stage: pick an archetype to show targeting, and use Assign to show
> the experiment.

---

## Context attributes the app sends

The browser sends `key`, `sessionId`, `archetypeMode`, and `archetype`. The server
([`lib/server/context.ts`](lib/server/context.ts)) validates them, keeps only these attributes, and
adds `eventSource` itself.

| Attribute | Example | Notes |
|---|---|---|
| `kind` | `user` | |
| `key` | `player-4f1c…` | Persisted in `localStorage` (`rap-battle:player-key`), so a returning player stays in the same bucket across rounds and reloads. **New player** in the UI mints a fresh one, for handing the laptop to the next person at the booth. A missing key is rejected; there's no shared "demo-user" fallback. |
| `sessionId` | `session-9a2e…` | Per browser tab (`sessionStorage`) |
| `archetypeMode` | `picked` \| `assigned` | Whether the player chose, or LD assigns |
| `archetype` | `wizard` | Roster `targetingValue`. **Only present in `picked` mode.** It's what the targeting rules match on. |
| `eventSource` | `live-demo` \| `pre-seeded` | Always set on the server. API traffic is `live-demo`; only the seed script sends `pre-seeded`. Use it to filter or segment results. |

The same context is used for both AI Config evaluations and the outcome event, so exposures and
conversions attribute to the same unit.

## Kill switch and fallback UI

The kill switch is each AI Config's own **off variation**; there are no separate boolean flags.
Turn a config off in LD and within about a second (streaming) the next call gets a disabled config.
The server returns `{"error": "config_disabled"}` **without making an LLM call**.

| Situation | Error code | What the player sees |
|---|---|---|
| Rapper config off (or no model / non-OpenAI provider / LD unreachable / keys missing) | `config_disabled`, `model_unavailable`, `provider_unavailable`, `config_unavailable` | **"The archetype battle is taking a break"**, a friendly backstage message with Retry |
| Judge config off (or same causes) | same codes, judge step | **"The judge has stepped out"**. Both verses stay on screen; no score and **no outcome event** |
| OpenAI timeout | `llm_timeout` | "Your opponent missed their cue" / "The judge is still deliberating" + Retry |
| Browser fetch timeout (30 s) | `request_timeout` | same as above |
| Unparseable model output | `invalid_verse` / `invalid_judge` | "fumbled the mic" / "lost their scorecard" + Retry |
| Anything else | `config_error` | same + Retry |

The server fails closed: the SDK default for both configs is `{ enabled: false }`, so a missing config
key or an uninitialized LD client shows the break screen instead of calling a model.

`POST /api/battle` always returns HTTP 200 with either the result or `{ "error": "<code>" }`, and
calls `ldClient.flush()` on every path.

## Timeouts, retries, and dedupe

- **OpenAI client:** `timeout: OPENAI_TIMEOUT_MS` (20 s) and **`maxRetries: 0`**, so the SDK never
  silently retries.
- **Browser fetch:** `AbortSignal.timeout(30 s)`, longer than the server's timeout, so server
  timeouts arrive as `llm_timeout`.
- **One outcome event per round:** the browser generates a `roundId` at Start and sends it with both
  calls. After a round is judged, a resubmit returns the cached result with `duplicate: true`, with
  no LLM call and no event. A concurrent double-submit gets `round_in_progress`. A failed judge call
  releases the round so Retry works. The server also keeps its own copy of the AI verse per round,
  so the judge scores what the model actually wrote, not the browser's echo.
- **Limit:** that round ledger is in-process memory ([`lib/server/rounds.ts`](lib/server/rounds.ts)).
  With `next start` or `next dev` (one process) it's complete. On multi-instance serverless, a
  resubmit could land on an instance that never saw the round. The browser disables Submit once a
  result exists, which is the second guard. If you deploy to serverless and need a hard guarantee,
  back the ledger with a shared store.

## Seeding a believable experiment

[`scripts/seed.ts`](scripts/seed.ts) is standalone and never runs as part of the app. For each
synthetic round it:

1. evaluates `archetype-rapper-config` for a fresh or replaying player in **assigned** mode, so LD's
   own randomization picks the arm and records a real exposure,
2. maps the served variation to a roster archetype,
3. draws an outcome from that archetype's `seed` rates in `config/archetypes.json`
   (`archetypeWinRate`, `tieRate`; a little jitter is added),
4. tracks exactly one of `archetype-win` / `human-win` / `tie` through the same `trackOutcome()` the
   app uses.

It makes **no LLM calls**. Seeded contexts are keyed `seed-<run>-<n>` with `eventSource: "pre-seeded"`.

```sh
npm run seed -- --rounds 50 --dry-run            # no LD connection; prints the simulated split
npm run seed -- --rounds 3000 --players 1200     # the real thing
npm run seed -- --rounds 600 --delay-ms 200      # trickle it in instead of bursting
```

Before running it for real:

- **Turn the config on and start the experiment iteration first.** LD only counts exposures and
  conversions that arrive *during* an iteration. The script stops if the config is serving its off
  variation.
- **You can't backdate.** SDK events are timestamped when they're sent, so the timeline shows a step
  at seed time rather than weeks of history. What seeding buys you is sample size and a settled
  result. To make it look organic, run it in several smaller batches over the days before the demo
  (`--delay-ms` spreads a batch out).
- Live rounds during the demo (in Assign mode) land in the same experiment and metrics in real time.
- To reset, stop the iteration and start a new one.

## Archetype roster

[`config/archetypes.json`](config/archetypes.json) is the whole roster. To add, remove, or rename an
archetype, edit the file. No code changes are needed.

| Field | Purpose |
|---|---|
| `id` | Internal id (event data, UI) |
| `label` | Display name |
| `targetingValue` | Sent as the `archetype` context attribute in picked mode. Your targeting rules match on it. |
| `variationKey` | Key of the `archetype-rapper-config` variation for this archetype |
| `persona.ref` / `persona.prompt` | Persona reference and prompt text, passed as `{{persona}}`. **TODO placeholders**; the real prompts go here or in the LD variation |
| `seed` | Seed-script outcome rates only |

When you add an archetype, also add its LD variation, its targeting rule, and include it in the experiment's arms.
Use generic archetypes only, never a named or licensed character.

## File map

| Path | What it does |
|---|---|
| `app/Battle.tsx` | The whole UI: the round state machine (pick → topic → generate → respond → judge → result), fallback states, "Under the hood" panel |
| `app/api/battle/route.ts` | Dispatcher: validation, `{error}` contract, flush on every path |
| `lib/server/clients.ts` | LD / AI / OpenAI singletons (init, timeouts, shutdown flush); `instrumentation.ts` warms them at boot |
| `lib/server/invoke.ts` | One AI Config call: evaluate, kill-switch checks, render instructions, OpenAI call, tracker metrics |
| `lib/server/battle.ts` | Generate and judge handlers, output contracts, parsing, outcome tracking |
| `lib/server/rounds.ts` | Per-round ledger: server copy of the verse, outcome dedupe |
| `lib/server/context.ts` | Server-side context rebuild and validation |
| `lib/server/json.ts` | `stripJsonCodeFence` / `safeParseJson` |
| `lib/outcomes.ts` | Outcome event keys and `trackOutcome()` (shared with the seed script) |
| `lib/client/*` | Browser context (persisted key) and fetch with timeout plus friendly error copy |
| `scripts/seed.ts`, `scripts/smoke.ts` | Seed tool and offline self-test |
