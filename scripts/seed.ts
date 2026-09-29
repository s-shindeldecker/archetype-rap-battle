/**
 * Pre-seed the archetype experiment with synthetic rounds. This is a standalone tool; the app never
 * calls it.
 *
 * Each synthetic round does what a real round does in LaunchDarkly terms, minus the LLM calls:
 *   1. Evaluate archetype-rapper-config for a context in "assigned" mode, so LD's randomization picks
 *      the arm and records a real exposure.
 *   2. Map the served variation to a roster archetype.
 *   3. Draw an outcome from that archetype's `seed` rates in config/archetypes.json.
 *   4. Track exactly one of archetype-win / human-win / tie, via the same trackOutcome() the app uses.
 *
 * Every seeded context has `eventSource: "pre-seeded"`, so you can separate or exclude it in LD.
 *
 *   npm run seed -- --rounds 2000 --players 700
 *   npm run seed -- --rounds 50 --dry-run
 *
 * Flags:
 *   --rounds N      rounds to generate (default 500)
 *   --players N     distinct player contexts. Players replay, which keeps their bucket (default rounds/2.5)
 *   --delay-ms N    pause between rounds, to trickle traffic instead of bursting (default 0)
 *   --dry-run       no LD connection; simulate a uniform split and print the summary
 */
import { init, type LDContext } from '@launchdarkly/node-server-sdk';
import { initAi } from '@launchdarkly/server-sdk-ai';
import { randomUUID } from 'node:crypto';
import { OUTCOME_EVENTS, trackOutcome } from '../lib/outcomes';
import { ARCHETYPES, findByVariationKey, type Archetype } from '../lib/roster';
import type { Winner } from '../lib/types';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file not present
  }
}

const RAPPER_CONFIG_KEY = process.env.LD_RAPPER_CONFIG_KEY || 'archetype-rapper-config';
const DEFAULT_WIN = 0.48;
const DEFAULT_TIE = 0.07;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}
const rounds = Math.max(1, Number(arg('rounds') ?? 500));
const players = Math.max(1, Number(arg('players') ?? Math.ceil(rounds / 2.5)));
const delayMs = Math.max(0, Number(arg('delay-ms') ?? 0));
const dryRun = process.argv.includes('--dry-run');

const runTag = randomUUID().slice(0, 8);
const playerPool = Array.from({ length: players }, (_, i) => ({
  key: `seed-${runTag}-${i}`,
  sessionId: `seed-session-${runTag}-${i}`,
}));

function drawOutcome(a: Archetype): Winner {
  // A little per-round jitter so the arms don't converge on suspiciously exact rates.
  const win = clamp((a.seed?.archetypeWinRate ?? DEFAULT_WIN) + (Math.random() - 0.5) * 0.04, 0, 1);
  const tie = clamp(a.seed?.tieRate ?? DEFAULT_TIE, 0, 1 - win);
  const r = Math.random();
  if (r < tie) return 'tie';
  if (r < tie + win) return 'archetype';
  return 'human';
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sdkKey = process.env.LAUNCHDARKLY_SDK_KEY;
  if (!dryRun && !sdkKey) throw new Error('LAUNCHDARKLY_SDK_KEY is required (or pass --dry-run)');

  const ld = dryRun ? null : init(sdkKey!, { capacity: 50_000, flushInterval: 2 });
  if (ld) await ld.waitForInitialization({ timeout: 15 });
  const ai = ld ? initAi(ld) : null;

  const tally = new Map<string, Record<Winner, number>>();
  let unknownVariation = 0;

  console.log(`${dryRun ? '[dry-run] ' : ''}seeding ${rounds} rounds across ${players} players (run ${runTag}) against ${RAPPER_CONFIG_KEY}`);

  for (let i = 0; i < rounds; i++) {
    const player = playerPool[Math.floor(Math.random() * playerPool.length)];
    const context: LDContext = {
      kind: 'user',
      key: player.key,
      sessionId: player.sessionId,
      archetypeMode: 'assigned',
      eventSource: 'pre-seeded',
    };

    let archetype: Archetype | undefined;
    let variationKey: string;
    if (ai) {
      const config = await ai.agentConfigTemplate(RAPPER_CONFIG_KEY, context, { enabled: false });
      variationKey = config.createTracker().getTrackData().variationKey;
      if (!config.enabled) {
        throw new Error(`${RAPPER_CONFIG_KEY} is serving its off variation. Turn it on and start the experiment before seeding.`);
      }
      archetype = findByVariationKey(variationKey);
    } else {
      archetype = ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)];
      variationKey = archetype.variationKey;
    }
    if (!archetype) {
      unknownVariation++;
      continue;
    }

    const winner = drawOutcome(archetype);
    if (ld) {
      trackOutcome(ld, context, winner, {
        roundId: randomUUID(),
        archetypeId: archetype.id,
        rapperVariationKey: variationKey,
        judgeVariationKey: 'pre-seeded',
        eventSource: 'pre-seeded',
      });
    }

    const row = tally.get(archetype.id) ?? { archetype: 0, human: 0, tie: 0 };
    row[winner]++;
    tally.set(archetype.id, row);

    if (ld && (i + 1) % 250 === 0) {
      await ld.flush();
      console.log(`  ${i + 1}/${rounds}`);
    }
    if (delayMs) await sleep(delayMs);
  }

  if (ld) {
    await ld.flush();
    ld.close();
  }

  console.log('\narchetype      rounds  archetype-win  human-win  tie');
  for (const a of ARCHETYPES) {
    const t = tally.get(a.id);
    if (!t) continue;
    const n = t.archetype + t.human + t.tie;
    const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`.padStart(6);
    console.log(`${a.label.padEnd(14)} ${String(n).padStart(6)}  ${pct(t.archetype).padStart(13)}  ${pct(t.human).padStart(9)}  ${pct(t.tie)}`);
  }
  if (unknownVariation) {
    console.warn(`\n${unknownVariation} rounds skipped: served variation isn't in config/archetypes.json. Check the variationKey slots.`);
  }
  console.log(`\nevents: ${Object.values(OUTCOME_EVENTS).join(', ')}. contexts: seed-${runTag}-*, eventSource=pre-seeded`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
