import type { ErrorCode } from '@/lib/types';

/** An expected failure with a stable code for the frontend. Anything else maps to `config_error`. */
export class BattleError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BattleError';
  }
}
