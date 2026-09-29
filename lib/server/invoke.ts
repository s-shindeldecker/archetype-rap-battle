import type { LDContext } from '@launchdarkly/node-server-sdk';
import type { LDAIMetrics } from '@launchdarkly/server-sdk-ai';
import Mustache from 'mustache';
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Clients } from './clients';
import { BattleError } from './errors';

/** Template variables, or a function that builds them once the served variation is known. */
export type Variables = Record<string, unknown> | ((variationKey: string) => Record<string, unknown>);

export interface AgentCallResult {
  content: string;
  variationKey: string;
  model: string;
  usage?: { input: number; output: number; total: number };
}

// LD stores model parameters as they were entered in the UI. Map the common camelCase names onto
// the Chat Completions field names and pass everything else through unchanged.
const PARAM_ALIASES: Record<string, string> = {
  maxTokens: 'max_completion_tokens',
  maxCompletionTokens: 'max_completion_tokens',
  max_tokens: 'max_completion_tokens',
  topP: 'top_p',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
};

function toOpenAIParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) out[PARAM_ALIASES[k] ?? k] = v;
  return out;
}

function openAIMetrics(resp: ChatCompletion): LDAIMetrics {
  const content = resp.choices[0]?.message?.content ?? '';
  return {
    success: content.trim().length > 0,
    tokens: resp.usage
      ? { input: resp.usage.prompt_tokens, output: resp.usage.completion_tokens, total: resp.usage.total_tokens }
      : undefined,
  };
}

/**
 * Exactly one LLM call against one agent-mode AI Config. It evaluates the config for this context, which
 * emits the flag evaluation (the experiment exposure). It enforces the off-variation kill switch
 * *before* any LLM call, runs Chat Completions with the variation's model and parameters, and records
 * duration, success/error, and tokens via the AI Config tracker. No retries and no fallback: failures
 * throw.
 */
export async function invokeAgent(
  clients: Clients,
  configKey: string,
  context: LDContext,
  variables: Variables,
  userMessage: string,
): Promise<AgentCallResult> {
  // Default = disabled. If LD is unreachable or the key doesn't exist, we fail closed into the fallback UI
  // instead of calling a model the dashboard never approved.
  //
  // agentConfigTemplate + our own Mustache render (same options the SDK uses) instead of agentConfig:
  // in "assigned" mode we only learn which archetype persona to inject after LD picks the variation.
  const config = await clients.ai.agentConfigTemplate(configKey, context, { enabled: false });
  const tracker = config.createTracker();
  const { variationKey } = tracker.getTrackData();

  if (!config.enabled) throw new BattleError('config_disabled', `${configKey} is serving its off variation`);
  if (!config.model?.name) throw new BattleError('model_unavailable', `${configKey}/${variationKey} has no model`);
  const provider = config.provider?.name?.toLowerCase() ?? '';
  if (!provider.includes('openai')) {
    throw new BattleError('provider_unavailable', `${configKey}/${variationKey} provider "${config.provider?.name}" is not OpenAI`);
  }

  const vars = typeof variables === 'function' ? variables(variationKey) : variables;
  const instructions = config.instructions
    ? Mustache.render(config.instructions, { ...vars, ldctx: context }, undefined, { escape: (s: string) => s })
    : '';

  const messages: ChatCompletionMessageParam[] = [];
  if (instructions) messages.push({ role: 'system', content: instructions });
  messages.push({ role: 'user', content: userMessage });

  let resp: ChatCompletion;
  try {
    resp = await tracker.trackMetricsOf(openAIMetrics, () =>
      clients.openai.chat.completions.create({
        ...toOpenAIParams(config.model?.parameters),
        model: config.model!.name,
        messages,
        stream: false,
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
    );
  } catch (err) {
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      throw new BattleError('llm_timeout', `${configKey} timed out`);
    }
    throw err;
  }

  const content = resp.choices[0]?.message?.content?.trim() ?? '';
  return {
    content,
    variationKey,
    model: config.model.name,
    usage: resp.usage
      ? { input: resp.usage.prompt_tokens, output: resp.usage.completion_tokens, total: resp.usage.total_tokens }
      : undefined,
  };
}
