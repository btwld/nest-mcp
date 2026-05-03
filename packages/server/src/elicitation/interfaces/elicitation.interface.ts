/**
 * Persisted state for a URL-mode elicitation. Created when a tool handler
 * (or other server code) needs to redirect the user to a browser-rendered
 * form and resume once the form is submitted.
 */
export interface ElicitationRecord {
  elicitationId: string;
  sessionId: string;
  userId?: string;
  status: 'pending' | 'complete' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  /**
   * Free-form metadata stored alongside the elicitation. The `type` field, if
   * present, enables {@link IElicitationStore.findResultByUserAndType} lookups
   * (e.g., re-using a previously captured API key).
   */
  metadata?: Record<string, unknown>;
}

/** Result of a completed URL elicitation. */
export interface ElicitationResultRecord {
  elicitationId: string;
  /** True for `confirm`, false for `cancel`. */
  success: boolean;
  action: 'confirm' | 'cancel';
  /** User-submitted form data (e.g., `{ apiKey: 'sk-...' }`). */
  data?: Record<string, unknown>;
  completedAt: Date;
  /** Mirrored from the originating record for direct lookup. */
  userId?: string;
  /** Mirrored from `metadata.type` for direct lookup. */
  type?: string;
}

export interface CreateElicitationParams {
  sessionId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  /** Override the module-default TTL in milliseconds. */
  ttlMs?: number;
}

export interface CompleteElicitationParams {
  elicitationId: string;
  success: boolean;
  action: 'confirm' | 'cancel';
  data?: Record<string, unknown>;
}
