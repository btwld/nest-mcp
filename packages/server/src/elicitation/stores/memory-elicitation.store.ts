import { Injectable, Logger } from '@nestjs/common';
import type {
  ElicitationRecord,
  ElicitationResultRecord,
} from '../interfaces/elicitation.interface';
import type { IElicitationStore } from '../interfaces/elicitation-store.interface';

/**
 * In-memory `IElicitationStore`. Suitable for development and single-instance
 * deployments. For multi-instance / multi-replica setups, plug in a
 * Redis-backed store via `storeConfiguration.type = 'custom'`.
 */
@Injectable()
export class MemoryElicitationStore implements IElicitationStore {
  private readonly logger = new Logger(MemoryElicitationStore.name);

  private readonly elicitations = new Map<string, ElicitationRecord>();
  private readonly results = new Map<string, ElicitationResultRecord>();
  /** `${userId}:${type}` → most recent matching elicitationId. */
  private readonly userTypeIndex = new Map<string, string>();

  async storeElicitation(elicitation: ElicitationRecord): Promise<void> {
    this.elicitations.set(elicitation.elicitationId, elicitation);
    this.indexUserType(elicitation);
  }

  async getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined> {
    const record = this.elicitations.get(elicitationId);
    if (!record) return undefined;
    if (record.expiresAt < new Date()) {
      await this.removeElicitation(elicitationId);
      return undefined;
    }
    return record;
  }

  async updateElicitation(
    elicitationId: string,
    updates: Partial<ElicitationRecord>,
  ): Promise<void> {
    const current = this.elicitations.get(elicitationId);
    if (!current) return;
    this.elicitations.set(elicitationId, { ...current, ...updates });
  }

  async storeResult(result: ElicitationResultRecord): Promise<void> {
    this.results.set(result.elicitationId, result);
    const record = this.elicitations.get(result.elicitationId);
    if (record) {
      this.elicitations.set(result.elicitationId, { ...record, status: 'complete' });
    }
  }

  async getResult(elicitationId: string): Promise<ElicitationResultRecord | undefined> {
    return this.results.get(elicitationId);
  }

  async findResultByUserAndType(
    userId: string,
    type: string,
  ): Promise<ElicitationResultRecord | undefined> {
    const indexedId = this.userTypeIndex.get(userTypeKey(userId, type));
    if (indexedId) {
      const indexed = this.results.get(indexedId);
      if (indexed?.userId === userId && indexed?.type === type) return indexed;
    }
    // Fallback scan — covers cases where the index points to an evicted record.
    for (const r of this.results.values()) {
      if (r.userId === userId && r.type === type) return r;
    }
    return undefined;
  }

  async removeElicitation(elicitationId: string): Promise<void> {
    const record = this.elicitations.get(elicitationId);
    if (record?.userId && typeof record.metadata?.type === 'string') {
      const key = userTypeKey(record.userId, record.metadata.type);
      if (this.userTypeIndex.get(key) === elicitationId) {
        this.userTypeIndex.delete(key);
      }
    }
    this.elicitations.delete(elicitationId);
    this.results.delete(elicitationId);
  }

  async getElicitationsBySession(sessionId: string): Promise<ElicitationRecord[]> {
    const now = new Date();
    const out: ElicitationRecord[] = [];
    for (const r of this.elicitations.values()) {
      if (r.sessionId === sessionId && r.expiresAt > now) out.push(r);
    }
    return out;
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    let removed = 0;
    for (const [id, record] of this.elicitations.entries()) {
      if (record.expiresAt < now) {
        await this.removeElicitation(id);
        removed++;
      }
    }
    if (removed > 0) this.logger.debug(`Cleaned up ${removed} expired elicitations`);
    return removed;
  }

  private indexUserType(record: ElicitationRecord): void {
    if (!record.userId || typeof record.metadata?.type !== 'string') return;
    this.userTypeIndex.set(userTypeKey(record.userId, record.metadata.type), record.elicitationId);
  }
}

function userTypeKey(userId: string, type: string): string {
  return `${userId}:${type}`;
}
