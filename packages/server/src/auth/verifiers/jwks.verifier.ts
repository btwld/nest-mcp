import { ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { McpAuthInfo } from '@nest-mcp/common';
import { McpError } from '@nest-mcp/common';
import type { JwksVerifierOptions } from '../interfaces/resource-server-options.interface';
import { audienceMatches } from './audience.util';
import type { BearerTokenVerifier } from './bearer-verifier.interface';

const DEFAULT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

/** Minimal structural view of the `jose` API surface this verifier uses. */
export interface JoseModule {
  createRemoteJWKSet(url: URL): unknown;
  jwtVerify(
    token: string,
    key: unknown,
    options: { issuer: string; audience?: string; algorithms: string[] },
  ): Promise<{ payload: Record<string, unknown> }>;
}

/**
 * Native dynamic `import()` kept out of TypeScript's reach so the CommonJS
 * build does not downlevel it to `require()` — the ESM-only jose v6 must be
 * loaded with a real dynamic import.
 */
const importJose = new Function('return import("jose")') as () => Promise<JoseModule>;

/**
 * Verifies asymmetrically signed JWT access tokens against a remote JWKS
 * (`jose` does key caching, cooldown, and `kid` selection). Audience binding
 * is enforced by default: either the explicit `audience` option or RFC 8707
 * matching of the `aud` claim against the canonical resource URL.
 *
 * Requires the optional `jose` peer dependency.
 */
export class JwksVerifier implements BearerTokenVerifier {
  private readonly algorithms: string[];
  private loaded?: Promise<{ jwtVerify: JoseModule['jwtVerify']; keySet: unknown }>;

  constructor(
    private readonly options: JwksVerifierOptions,
    private readonly resource: string,
    private readonly validateAudience: boolean = true,
    private readonly loadJose: () => Promise<JoseModule> = importJose,
  ) {
    this.algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;
    const forbidden = this.algorithms.filter(
      (alg) => /^hs/i.test(alg) || alg.toLowerCase() === 'none',
    );
    if (forbidden.length > 0) {
      throw new McpError(
        `McpAuthModule: symmetric/none algorithms are not allowed for the jwks verifier (${forbidden.join(', ')}) — use a custom verifier for shared-secret setups`,
      );
    }
  }

  async verify(token: string): Promise<McpAuthInfo | null> {
    const { jwtVerify, keySet } = await this.load();

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.algorithms,
      }));
    } catch (error) {
      // jose validation failures (bad signature/claims/key mismatch) mean the
      // TOKEN is invalid → 401. JWKS-resolution/network failures are OUR
      // infrastructure → 500, so SDK clients retry instead of discarding
      // their tokens and re-authorizing.
      const code = (error as { code?: string })?.code ?? '';
      const isTokenError =
        code.startsWith('ERR_J') && code !== 'ERR_JWKS_TIMEOUT' && code !== 'ERR_JWKS_INVALID';
      if (isTokenError) return null;
      throw new ServerError('Failed to verify token against the JWKS endpoint');
    }

    if (
      !this.options.audience &&
      this.validateAudience &&
      !audienceMatches(payload.aud, this.resource)
    ) {
      return null;
    }

    return {
      token,
      clientId: (payload.azp as string) ?? (payload.client_id as string) ?? '',
      scopes: extractScopes(payload),
      expiresAt: payload.exp as number | undefined,
      extra: { ...payload },
    };
  }

  private load(): Promise<{ jwtVerify: JoseModule['jwtVerify']; keySet: unknown }> {
    this.loaded ??= this.loadJose().then(
      (jose) => ({
        jwtVerify: jose.jwtVerify.bind(jose),
        keySet: jose.createRemoteJWKSet(new URL(this.options.uri)),
      }),
      () => {
        this.loaded = undefined;
        throw new McpError(
          "McpAuthModule: the 'jwks' verifier requires the optional 'jose' package — install it (e.g. `pnpm add jose`)",
        );
      },
    );
    return this.loaded;
  }
}

/** `scope` (space-delimited, RFC 8693) with fallback to `scp` (string or array). */
function extractScopes(payload: Record<string, unknown>): string[] {
  if (typeof payload.scope === 'string') return payload.scope.split(' ').filter(Boolean);
  if (typeof payload.scp === 'string') return payload.scp.split(' ').filter(Boolean);
  if (Array.isArray(payload.scp))
    return payload.scp.filter((s): s is string => typeof s === 'string');
  return [];
}
