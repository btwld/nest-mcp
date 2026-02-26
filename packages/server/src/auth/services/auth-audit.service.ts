import { Injectable, Logger } from '@nestjs/common';

export interface AuditLogEntry {
  timestamp: string;
  eventType: string;
  clientId?: string;
  userId?: string;
  ip?: string;
  outcome: 'success' | 'failure';
  details?: Record<string, unknown>;
}

@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger('AuthAudit');

  logTokenIssued(clientId: string, userId: string, ip?: string): void {
    this.log({
      eventType: 'token_issued',
      clientId,
      userId,
      ip,
      outcome: 'success',
    });
  }

  logTokenRevoked(jti: string, ip?: string): void {
    this.log({
      eventType: 'token_revoked',
      ip,
      outcome: 'success',
      details: { jti },
    });
  }

  logClientRegistered(clientId: string, clientName: string, ip?: string): void {
    this.log({
      eventType: 'client_registered',
      clientId,
      ip,
      outcome: 'success',
      details: { clientName },
    });
  }

  logAuthorizationGranted(clientId: string, userId: string, ip?: string): void {
    this.log({
      eventType: 'authorization_granted',
      clientId,
      userId,
      ip,
      outcome: 'success',
    });
  }

  logAuthorizationDenied(clientId: string, reason: string, ip?: string): void {
    this.log({
      eventType: 'authorization_denied',
      clientId,
      ip,
      outcome: 'failure',
      details: { reason },
    });
  }

  logRateLimited(ip: string): void {
    this.log({
      eventType: 'rate_limited',
      ip,
      outcome: 'failure',
    });
  }

  private log(entry: Omit<AuditLogEntry, 'timestamp'>): void {
    const logEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.logger.log(JSON.stringify(logEntry));
  }
}
