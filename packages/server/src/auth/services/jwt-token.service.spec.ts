import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { JwtTokenService } from './jwt-token.service';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';

describe('JwtTokenService', () => {
  const secret = 'test-jwt-secret-key-for-unit-tests';

  function createService(overrides: Partial<McpAuthModuleOptions> = {}): JwtTokenService {
    const options: McpAuthModuleOptions = {
      jwtSecret: secret,
      ...overrides,
    };
    return new JwtTokenService(options);
  }

  // --- generateTokenPair ---

  describe('generateTokenPair', () => {
    it('returns access_token, refresh_token, token_type "Bearer", and expires_in', () => {
      const service = createService();
      const result = service.generateTokenPair('user-1', 'client-1');

      expect(result.access_token).toEqual(expect.any(String));
      expect(result.refresh_token).toEqual(expect.any(String));
      expect(result.token_type).toBe('Bearer');
      expect(result.expires_in).toEqual(expect.any(Number));
    });

    it('includes scope in the access token payload', () => {
      const service = createService();
      const result = service.generateTokenPair('user-1', 'client-1', 'read write');

      const decoded = jwt.decode(result.access_token) as any;
      expect(decoded.scope).toBe('read write');
    });

    it('sets issuer from options.issuer', () => {
      const service = createService({ issuer: 'https://my-issuer.com' });
      const result = service.generateTokenPair('user-1', 'client-1');

      const decoded = jwt.decode(result.access_token) as any;
      expect(decoded.iss).toBe('https://my-issuer.com');
    });

    it('falls back to options.serverUrl when issuer not set', () => {
      const service = createService({ serverUrl: 'https://server.com' });
      const result = service.generateTokenPair('user-1', 'client-1');

      const decoded = jwt.decode(result.access_token) as any;
      expect(decoded.iss).toBe('https://server.com');
    });

    it('falls back to localhost when neither issuer nor serverUrl set', () => {
      const service = createService();
      const result = service.generateTokenPair('user-1', 'client-1');

      const decoded = jwt.decode(result.access_token) as any;
      expect(decoded.iss).toBe('http://localhost:3000');
    });

    it('sets audience from options or defaults to mcp-client', () => {
      const serviceCustom = createService({ audience: 'my-audience' });
      const resultCustom = serviceCustom.generateTokenPair('user-1', 'client-1');
      const decodedCustom = jwt.decode(resultCustom.access_token) as any;
      expect(decodedCustom.aud).toBe('my-audience');

      const serviceDefault = createService();
      const resultDefault = serviceDefault.generateTokenPair('user-1', 'client-1');
      const decodedDefault = jwt.decode(resultDefault.access_token) as any;
      expect(decodedDefault.aud).toBe('mcp-client');
    });

    it('sets sub and azp on access token', () => {
      const service = createService();
      const result = service.generateTokenPair('user-42', 'client-99');

      const decoded = jwt.decode(result.access_token) as any;
      expect(decoded.sub).toBe('user-42');
      expect(decoded.azp).toBe('client-99');
      expect(decoded.type).toBe('access');
    });

    it('sets sub, client_id, type=refresh, and jti on refresh token', () => {
      const service = createService();
      const result = service.generateTokenPair('user-42', 'client-99');

      const decoded = jwt.decode(result.refresh_token) as any;
      expect(decoded.sub).toBe('user-42');
      expect(decoded.client_id).toBe('client-99');
      expect(decoded.type).toBe('refresh');
      expect(decoded.jti).toEqual(expect.any(String));
    });

    it('respects accessTokenExpiresIn option', () => {
      const service = createService({ accessTokenExpiresIn: '2h' });
      const result = service.generateTokenPair('user-1', 'client-1');

      expect(result.expires_in).toBe(7200);
    });
  });

  // --- validateToken ---

  describe('validateToken', () => {
    it('validates a good token and returns payload', () => {
      const service = createService();
      const result = service.generateTokenPair('user-1', 'client-1', 'read');

      const payload = service.validateToken(result.access_token);
      expect(payload.sub).toBe('user-1');
      expect(payload.scope).toBe('read');
    });

    it('throws on expired token', () => {
      const service = createService({ accessTokenExpiresIn: '1s' });
      const token = jwt.sign({ sub: 'u', type: 'access' }, secret, { expiresIn: -1 });

      expect(() => service.validateToken(token)).toThrow('Invalid token');
    });

    it('throws on wrong secret', () => {
      const token = jwt.sign({ sub: 'u' }, 'wrong-secret', { algorithm: 'HS256' });
      const service = createService();

      expect(() => service.validateToken(token)).toThrow('Invalid token');
    });

    it('throws on malformed token', () => {
      const service = createService();

      expect(() => service.validateToken('not.a.token')).toThrow('Invalid token');
    });
  });

  // --- parseExpiresIn ---

  describe('parseExpiresIn (via generateTokenPair expires_in)', () => {
    it('parses "30s" to 30', () => {
      const service = createService({ accessTokenExpiresIn: '30s' });
      const result = service.generateTokenPair('u', 'c');
      expect(result.expires_in).toBe(30);
    });

    it('parses "5m" to 300', () => {
      const service = createService({ accessTokenExpiresIn: '5m' });
      const result = service.generateTokenPair('u', 'c');
      expect(result.expires_in).toBe(300);
    });

    it('parses "2h" to 7200', () => {
      const service = createService({ accessTokenExpiresIn: '2h' });
      const result = service.generateTokenPair('u', 'c');
      expect(result.expires_in).toBe(7200);
    });

    it('parses "1d" to 86400', () => {
      const service = createService({ accessTokenExpiresIn: '1d' });
      const result = service.generateTokenPair('u', 'c');
      expect(result.expires_in).toBe(86400);
    });

    it('returns 86400 for unparseable value', () => {
      const service = createService({ accessTokenExpiresIn: 'invalid' });
      const result = service.generateTokenPair('u', 'c');
      expect(result.expires_in).toBe(86400);
    });
  });
});
