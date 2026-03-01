import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AuthAuditService } from './auth-audit.service';

describe('AuthAuditService', () => {
  let service: AuthAuditService;
  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new AuthAuditService();
    logSpy = vi.fn();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(logSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getLoggedEntry(): Record<string, unknown> {
    expect(logSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(logSpy.mock.calls[0][0] as string);
  }

  it('logs token issued events', () => {
    service.logTokenIssued('client-1', 'user-1', '127.0.0.1');
    const entry = getLoggedEntry();
    expect(entry.eventType).toBe('token_issued');
    expect(entry.clientId).toBe('client-1');
    expect(entry.userId).toBe('user-1');
    expect(entry.ip).toBe('127.0.0.1');
    expect(entry.outcome).toBe('success');
    expect(entry.timestamp).toBeDefined();
  });

  it('logs token revoked events', () => {
    service.logTokenRevoked('jti-abc', '10.0.0.1');
    const entry = getLoggedEntry();
    expect(entry.eventType).toBe('token_revoked');
    expect(entry.outcome).toBe('success');
    expect((entry.details as Record<string, unknown>).jti).toBe('jti-abc');
  });

  it('logs client registered events', () => {
    service.logClientRegistered('client-2', 'My App');
    const entry = getLoggedEntry();
    expect(entry.eventType).toBe('client_registered');
    expect(entry.clientId).toBe('client-2');
    expect((entry.details as Record<string, unknown>).clientName).toBe('My App');
  });

  it('logs authorization granted events', () => {
    service.logAuthorizationGranted('client-1', 'user-1', '::1');
    const entry = getLoggedEntry();
    expect(entry.eventType).toBe('authorization_granted');
    expect(entry.outcome).toBe('success');
  });

  it('logs authorization denied events', () => {
    service.logAuthorizationDenied('client-1', 'invalid scope');
    const entry = getLoggedEntry();
    expect(entry.eventType).toBe('authorization_denied');
    expect(entry.outcome).toBe('failure');
    expect((entry.details as Record<string, unknown>).reason).toBe('invalid scope');
  });

  it('logs rate limited events', () => {
    service.logRateLimited('192.168.1.1');
    const entry = getLoggedEntry();
    expect(entry.eventType).toBe('rate_limited');
    expect(entry.ip).toBe('192.168.1.1');
    expect(entry.outcome).toBe('failure');
  });

  it('timestamp is a valid ISO 8601 string', () => {
    service.logTokenIssued('c', 'u');
    const entry = getLoggedEntry();
    expect(typeof entry.timestamp).toBe('string');
    expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp);
  });

  it('logTokenRevoked without ip leaves ip undefined', () => {
    service.logTokenRevoked('jti-xyz');
    const entry = getLoggedEntry();
    expect(entry.ip).toBeUndefined();
  });

  it('logClientRegistered includes ip when provided', () => {
    service.logClientRegistered('client-3', 'App Name', '10.0.0.2');
    const entry = getLoggedEntry();
    expect(entry.ip).toBe('10.0.0.2');
    expect(entry.outcome).toBe('success');
  });
});
