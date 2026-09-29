// Warm the LD + OpenAI clients at server start so the first round on stage doesn't pay the LD init cost.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { getClients } = await import('./lib/server/clients');
  getClients().catch((err) => console.error('[battle] client init failed; will retry on first request:', err.message));
}
