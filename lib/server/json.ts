// JSON hardening for LLM output. Ported from the reference app's strip_json_code_fence / safe_parse_json.

export function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Parses an object from model output. Tolerates code fences, prose around the JSON, and a nested `output`/`result` wrapper. */
export function safeParseJson(text: string): Record<string, unknown> | null {
  const body = stripJsonCodeFence(text);
  const candidates = [body];
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first > 0 || (last !== -1 && last < body.length - 1)) {
    candidates.push(body.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return unwrap(parsed as Record<string, unknown>);
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function unwrap(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['output', 'result']) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return obj;
}
