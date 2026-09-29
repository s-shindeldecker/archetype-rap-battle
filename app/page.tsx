import { ARCHETYPES, JUDGE_CRITERIA } from '@/lib/roster';
import Battle from './Battle';

export default function Page() {
  // Only id/label/targetingValue reach the browser. Persona prompts stay on the server.
  const roster = ARCHETYPES.map(({ id, label, targetingValue }) => ({ id, label, targetingValue }));
  return <Battle roster={roster} criteria={JUDGE_CRITERIA} />;
}
