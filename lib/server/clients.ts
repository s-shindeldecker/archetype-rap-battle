import 'server-only';
import { init, type LDClient } from '@launchdarkly/node-server-sdk';
import { initAi, type LDAIClient } from '@launchdarkly/server-sdk-ai';
import OpenAI from 'openai';
import { BattleError } from './errors';

export const RAPPER_CONFIG_KEY = process.env.LD_RAPPER_CONFIG_KEY || 'archetype-rapper-config';
export const JUDGE_CONFIG_KEY = process.env.LD_JUDGE_CONFIG_KEY || 'battle-judge-config';

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 20_000;
const LD_INIT_TIMEOUT_SECONDS = Number(process.env.LD_INIT_TIMEOUT_SECONDS) || 10;

export interface Clients {
  ld: LDClient;
  ai: LDAIClient;
  openai: OpenAI;
}

// One set of clients per server process. Cached on globalThis so Next dev HMR doesn't open a new
// LD streaming connection on every reload. This stands in for the reference app's FastAPI lifespan().
const g = globalThis as unknown as { __battleClients?: Promise<Clients> };

async function create(): Promise<Clients> {
  const sdkKey = process.env.LAUNCHDARKLY_SDK_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!sdkKey || !openaiKey) {
    throw new BattleError('config_unavailable', 'LAUNCHDARKLY_SDK_KEY and OPENAI_API_KEY are required');
  }

  const ld = init(sdkKey);
  try {
    await ld.waitForInitialization({ timeout: LD_INIT_TIMEOUT_SECONDS });
  } catch (err) {
    ld.close();
    throw new BattleError('config_unavailable', `LaunchDarkly did not initialize: ${String(err)}`);
  }

  const ai = initAi(ld);
  // maxRetries: 0 is deliberate. A round is exactly two LLM calls. On failure the error goes to the
  // user, who can retry. The SDK must not retry on its own and stretch the latency on stage.
  const openai = new OpenAI({ apiKey: openaiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 });

  const shutdown = () => void ld.flush().finally(() => ld.close());
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return { ld, ai, openai };
}

export function getClients(): Promise<Clients> {
  if (!g.__battleClients) {
    g.__battleClients = create().catch((err) => {
      // Don't cache a failed init. The next request tries again.
      g.__battleClients = undefined;
      throw err;
    });
  }
  return g.__battleClients;
}
