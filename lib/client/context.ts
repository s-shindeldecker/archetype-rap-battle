'use client';

import type { ArchetypeMode, ContextPayload } from '@/lib/types';

const PLAYER_KEY = 'rap-battle:player-key';
const SESSION_KEY = 'rap-battle:session-id';

/** Player key, persisted in localStorage so a returning player keeps the same LD bucket across rounds and reloads. */
export function getPlayerKey(): string {
  let key = localStorage.getItem(PLAYER_KEY);
  if (!key) {
    key = `player-${crypto.randomUUID()}`;
    localStorage.setItem(PLAYER_KEY, key);
  }
  return key;
}

/** Per-tab session id (sessionStorage), sent as the `sessionId` attribute. */
export function getSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `session-${crypto.randomUUID()}`;
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/** Hands the next person at the booth a fresh player (a new LD context, so a new experiment bucket). */
export function resetPlayer(): string {
  localStorage.removeItem(PLAYER_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  return getPlayerKey();
}

export function buildContextPayload(mode: ArchetypeMode, archetype?: string): ContextPayload {
  return {
    key: getPlayerKey(),
    sessionId: getSessionId(),
    archetypeMode: mode,
    ...(mode === 'picked' && archetype ? { archetype } : {}),
  };
}
