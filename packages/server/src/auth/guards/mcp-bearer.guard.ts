import {
  InsufficientScopeError,
  InvalidTokenError,
  OAuthError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { McpAuthInfo } from '@nest-mcp/common';
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { MCP_BEARER_TOKEN_VERIFIER, MCP_RESOURCE_SERVER_OPTIONS } from '../auth.constants';
import type { McpResourceServerOptions } from '../interfaces/resource-server-options.interface';
import { buildResourceMetadataUrl } from '../utils/resource-url.util';
import type { BearerTokenVerifier } from '../verifiers/bearer-verifier.interface';

interface HttpRequest {
  headers?: Record<string, string | string[] | undefined>;
  /** Verified bearer identity; the SDK transport reads this and surfaces it as `authInfo`. */
  auth?: McpAuthInfo;
}

interface HttpResponse {
  /** Express / Node `ServerResponse` header setter. */
  setHeader?: (name: string, value: string) => unknown;
  /** Fastify reply header setter. */
  header?: (name: string, value: string) => unknown;
}

/**
 * Bearer-token gate for MCP HTTP transports. Wire-behavior matches the SDK's
 * `requireBearerAuth` middleware exactly — official clients regex-parse the
 * `WWW-Authenticate` challenge (`extractWWWAuthenticateParams`) and key
 * recovery behavior off the RFC 6749 error bodies:
 *
 * - missing/malformed/invalid token → 401 `error="invalid_token"`
 * - missing required scopes → 403 `error="insufficient_scope"`
 * - other OAuth errors → 400; unexpected failures → 500 `server_error`
 *
 * On success the verified identity is attached to `req.auth`, which the SDK
 * transports surface to handlers as `extra.authInfo`. When
 * `required === false`, requests without an Authorization header pass through
 * anonymously; a present-but-invalid token is still rejected (RFC 6750).
 */
@Injectable()
export class McpBearerGuard implements CanActivate {
  private readonly logger = new Logger(McpBearerGuard.name);
  private options?: McpResourceServerOptions;
  private verifier?: BearerTokenVerifier;

  constructor(private readonly moduleRef: ModuleRef) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const options = this.resolveOptions();

    try {
      const rawHeader = req.headers?.authorization;
      const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (!authHeader) {
        if (options.required === false) return true;
        throw new InvalidTokenError('Missing Authorization header');
      }

      const [type, token] = authHeader.split(' ');
      if (type?.toLowerCase() !== 'bearer' || !token) {
        throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
      }

      const authInfo = await this.resolveVerifier().verify(token);
      if (!authInfo) {
        throw new InvalidTokenError('Invalid or expired token');
      }

      const requiredScopes = options.requiredScopes ?? [];
      if (requiredScopes.length > 0) {
        const hasAllScopes = requiredScopes.every((scope) => authInfo.scopes.includes(scope));
        if (!hasAllScopes) {
          throw new InsufficientScopeError('Insufficient scope');
        }
      }

      if (typeof authInfo.expiresAt !== 'number' || Number.isNaN(authInfo.expiresAt)) {
        throw new InvalidTokenError('Token has no expiration time');
      }
      if (authInfo.expiresAt < Date.now() / 1000) {
        throw new InvalidTokenError('Token has expired');
      }

      req.auth = authInfo;
      return true;
    } catch (error) {
      throw this.toHttpException(error, res, options);
    }
  }

  private toHttpException(
    error: unknown,
    res: HttpResponse,
    options: McpResourceServerOptions,
  ): HttpException {
    if (error instanceof InvalidTokenError) {
      this.setChallenge(res, error, options);
      return new HttpException(error.toResponseObject(), 401);
    }
    if (error instanceof InsufficientScopeError) {
      this.setChallenge(res, error, options);
      return new HttpException(error.toResponseObject(), 403);
    }
    if (error instanceof ServerError) {
      return new HttpException(error.toResponseObject(), 500);
    }
    if (error instanceof OAuthError) {
      return new HttpException(error.toResponseObject(), 400);
    }
    this.logger.error('Unexpected error verifying bearer token', error);
    return new HttpException(new ServerError('Internal Server Error').toResponseObject(), 500);
  }

  private setChallenge(
    res: HttpResponse,
    error: OAuthError,
    options: McpResourceServerOptions,
  ): void {
    let challenge = `Bearer error="${error.errorCode}", error_description="${error.message}"`;
    const requiredScopes = options.requiredScopes ?? [];
    if (requiredScopes.length > 0) {
      challenge += `, scope="${requiredScopes.join(' ')}"`;
    }
    challenge += `, resource_metadata="${buildResourceMetadataUrl(options.resource)}"`;

    if (typeof res.setHeader === 'function') {
      res.setHeader('WWW-Authenticate', challenge);
    } else {
      res.header?.('WWW-Authenticate', challenge);
    }
  }

  private resolveOptions(): McpResourceServerOptions {
    this.options ??= this.resolveToken<McpResourceServerOptions>(
      MCP_RESOURCE_SERVER_OPTIONS,
      'McpBearerGuard requires McpAuthModule — import McpAuthModule.forRoot(...) or provide MCP_RESOURCE_SERVER_OPTIONS.',
    );
    return this.options;
  }

  private resolveVerifier(): BearerTokenVerifier {
    this.verifier ??= this.resolveToken<BearerTokenVerifier>(
      MCP_BEARER_TOKEN_VERIFIER,
      'McpBearerGuard requires a token verifier — import McpAuthModule.forRoot(...) or provide MCP_BEARER_TOKEN_VERIFIER.',
    );
    return this.verifier;
  }

  private resolveToken<T>(token: symbol, message: string): T {
    try {
      return this.moduleRef.get<T>(token, { strict: false });
    } catch {
      this.logger.error(message);
      throw new HttpException(new ServerError('Internal Server Error').toResponseObject(), 500);
    }
  }
}
