import type { ElicitationRecord, ElicitationResultRecord } from './elicitation.interface';

/**
 * Storage backend for URL-mode elicitations. Implementations may use memory
 * (default), Redis, a database, or any other backing store. All methods are
 * async to support remote stores.
 */
export interface IElicitationStore {
  storeElicitation(elicitation: ElicitationRecord): Promise<void>;
  getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined>;
  updateElicitation(elicitationId: string, updates: Partial<ElicitationRecord>): Promise<void>;
  storeResult(result: ElicitationResultRecord): Promise<void>;
  getResult(elicitationId: string): Promise<ElicitationResultRecord | undefined>;
  /**
   * Find the most recent completed result for a `(userId, type)` pair where
   * `type` is sourced from `metadata.type` on the originating record.
   */
  findResultByUserAndType(
    userId: string,
    type: string,
  ): Promise<ElicitationResultRecord | undefined>;
  removeElicitation(elicitationId: string): Promise<void>;
  getElicitationsBySession(sessionId: string): Promise<ElicitationRecord[]>;
  /** Returns the number of records purged. */
  cleanupExpired(): Promise<number>;
}

export const ELICITATION_STORE_TOKEN = Symbol('ELICITATION_STORE');
