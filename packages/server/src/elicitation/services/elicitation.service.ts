import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ELICITATION_MODULE_OPTIONS,
  type ResolvedElicitationOptions,
} from '../interfaces/elicitation-options.interface';
import {
  ELICITATION_STORE_TOKEN,
  type IElicitationStore,
} from '../interfaces/elicitation-store.interface';
import type {
  CompleteElicitationParams,
  CreateElicitationParams,
  ElicitationRecord,
  ElicitationResultRecord,
} from '../interfaces/elicitation.interface';

/** Callback invoked once an elicitation completes. */
export type CompletionNotifier = () => Promise<void>;

/** Thrown by `waitForCompletion` when the user cancels the form submission. */
export class ElicitationCancelledError extends Error {
  constructor(public readonly result: ElicitationResultRecord) {
    super('Elicitation was cancelled by the user');
    this.name = 'ElicitationCancelledError';
  }
}

/**
 * Registry mapping `elicitationId` → notifier. Stored in memory because
 * callbacks aren't serializable; multi-instance deployments must register
 * the notifier on the same instance that handles the completion request
 * (typically using a sticky session).
 */
export type CompletionNotifierRegistry = Map<string, CompletionNotifier>;

export const COMPLETION_NOTIFIER_REGISTRY = Symbol('COMPLETION_NOTIFIER_REGISTRY');

@Injectable()
export class ElicitationService implements OnModuleDestroy {
  private readonly logger = new Logger(ElicitationService.name);
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(ELICITATION_STORE_TOKEN) private readonly store: IElicitationStore,
    @Inject(ELICITATION_MODULE_OPTIONS) private readonly options: ResolvedElicitationOptions,
    @Inject(COMPLETION_NOTIFIER_REGISTRY)
    private readonly notifierRegistry: CompletionNotifierRegistry,
  ) {
    this.startCleanupInterval();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async createElicitation(params: CreateElicitationParams): Promise<string> {
    const elicitationId = randomUUID();
    const now = new Date();
    const ttlMs = params.ttlMs ?? this.options.elicitationTtlMs;
    const record: ElicitationRecord = {
      elicitationId,
      sessionId: params.sessionId,
      userId: params.userId,
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      metadata: params.metadata,
    };
    await this.store.storeElicitation(record);
    this.logger.log(`Created elicitation ${elicitationId} for session ${params.sessionId}`);
    return elicitationId;
  }

  registerCompletionNotifier(elicitationId: string, notifier: CompletionNotifier): void {
    this.notifierRegistry.set(elicitationId, notifier);
  }

  /**
   * Build a public URL for an elicitation endpoint. `path` should be one of
   * the configured endpoint paths (e.g. `api-key`, `confirm`).
   */
  buildElicitationUrl(
    elicitationId: string,
    path?: string,
    query?: Record<string, string>,
  ): string {
    const base = this.options.serverUrl.replace(/\/$/, '');
    const prefix = this.options.apiPrefix;
    let url = `${base}/${prefix}/${elicitationId}`;
    if (path) url += `/${path}`;
    if (query && Object.keys(query).length > 0) {
      url += `?${new URLSearchParams(query).toString()}`;
    }
    return url;
  }

  async getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined> {
    return this.store.getElicitation(elicitationId);
  }

  /**
   * Persist the result, mark the record complete, and fire the registered
   * completion notifier (if any). Returns true when a notifier was fired.
   */
  async completeElicitation(params: CompleteElicitationParams): Promise<boolean> {
    const record = await this.store.getElicitation(params.elicitationId);
    if (!record) {
      this.logger.warn(`Cannot complete unknown elicitation ${params.elicitationId}`);
      return false;
    }
    if (record.status === 'complete') {
      this.logger.warn(`Elicitation ${params.elicitationId} already complete`);
      return false;
    }

    const result: ElicitationResultRecord = {
      elicitationId: params.elicitationId,
      success: params.success,
      action: params.action,
      data: params.data,
      completedAt: new Date(),
      userId: record.userId,
      type: typeof record.metadata?.type === 'string' ? record.metadata.type : undefined,
    };
    await this.store.storeResult(result);

    const notifier = this.notifierRegistry.get(params.elicitationId);
    if (!notifier) return false;

    try {
      await notifier();
      this.notifierRegistry.delete(params.elicitationId);
      return true;
    } catch (error) {
      this.logger.error(
        `Completion notifier failed for elicitation ${params.elicitationId}`,
        error,
      );
      return false;
    }
  }

  async getResult(elicitationId: string): Promise<ElicitationResultRecord | undefined> {
    return this.store.getResult(elicitationId);
  }

  async findResultByUserAndType(
    userId: string,
    type: string,
  ): Promise<ElicitationResultRecord | undefined> {
    return this.store.findResultByUserAndType(userId, type);
  }

  async removeElicitation(elicitationId: string): Promise<void> {
    await this.store.removeElicitation(elicitationId);
    this.notifierRegistry.delete(elicitationId);
  }

  async getElicitationsBySession(sessionId: string): Promise<ElicitationRecord[]> {
    return this.store.getElicitationsBySession(sessionId);
  }

  /**
   * High-level helper for the URL-elicitation flow. Creates a record, returns
   * the user-facing URL plus a `waitForCompletion` Promise that resolves once
   * the user submits the form (or rejects when the elicitation is cancelled,
   * times out, or the abort signal fires).
   *
   * The caller is responsible for telling the MCP client to open the URL —
   * typically via `ctx.elicit({ mode: 'url', message, url, elicitationId })`.
   */
  async startUrlElicitation(params: {
    sessionId: string;
    userId?: string;
    /** Endpoint to surface (e.g. `'api-key'`, `'confirm'`). Defaults to `'api-key'`. */
    path?: string;
    /** Metadata stored with the record; merged into form-template inputs. */
    metadata?: Record<string, unknown>;
    /** Override the module-default TTL in milliseconds. */
    ttlMs?: number;
  }): Promise<{
    elicitationId: string;
    url: string;
    /** Resolves with the form result, or rejects on cancel/timeout/abort. */
    waitForCompletion: (options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
    }) => Promise<ElicitationResultRecord>;
  }> {
    const elicitationId = await this.createElicitation({
      sessionId: params.sessionId,
      userId: params.userId,
      metadata: params.metadata,
      ttlMs: params.ttlMs,
    });
    const url = this.buildElicitationUrl(elicitationId, params.path ?? 'api-key');

    const waitForCompletion = (options?: { signal?: AbortSignal; timeoutMs?: number }) =>
      new Promise<ElicitationResultRecord>((resolve, reject) => {
        const cleanup = () => {
          this.notifierRegistry.delete(elicitationId);
          options?.signal?.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
        };
        const onAbort = () => {
          cleanup();
          reject(new Error('Elicitation aborted'));
        };
        const timer = options?.timeoutMs
          ? setTimeout(() => {
              cleanup();
              reject(new Error('Elicitation timed out'));
            }, options.timeoutMs)
          : null;
        if (options?.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
        this.registerCompletionNotifier(elicitationId, async () => {
          cleanup();
          const result = await this.store.getResult(elicitationId);
          if (!result) {
            reject(new Error('Elicitation completed without a stored result'));
            return;
          }
          if (result.action === 'cancel' || !result.success) {
            reject(new ElicitationCancelledError(result));
            return;
          }
          resolve(result);
        });
      });

    return { elicitationId, url, waitForCompletion };
  }

  private startCleanupInterval(): void {
    this.cleanupTimer = setInterval(() => {
      this.store.cleanupExpired().catch((error) => {
        this.logger.error('Elicitation cleanup failed', error);
      });
    }, this.options.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }
}
