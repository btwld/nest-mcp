import { createMcpTokenKeyRing, generateMcpSigningKey, signMcpAccessToken } from "../jwt/issuer.ts";
import type {
	McpAccessTokenClaims,
	McpTokenKeyRing,
	McpTokenSigningAlgorithm,
} from "../jwt/issuer.ts";

export interface McpTestKeyRing {
	readonly ring: McpTokenKeyRing;
	/** Mints an `at+jwt` with sane defaults; override any claim per test. */
	readonly mintAccessToken: (
		claims: Partial<McpAccessTokenClaims> & { readonly aud: string },
	) => string;
}

export interface McpTestKeyRingOptions {
	readonly alg?: Exclude<McpTokenSigningAlgorithm, "HS256">;
	readonly issuer?: string;
	readonly now?: () => number;
}

/** Ephemeral signing ring for tests: every call generates a fresh keypair. */
export function createMcpTestKeyRing(options?: McpTestKeyRingOptions): McpTestKeyRing {
	const issuer = options?.issuer ?? "https://issuer.test";
	const now = options?.now ?? Date.now;
	const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey(options?.alg ?? "EdDSA")] });
	return {
		ring,
		mintAccessToken: (claims) => {
			const nowSeconds = Math.floor(now() / 1_000);
			return signMcpAccessToken(ring, {
				iss: issuer,
				sub: "user-test",
				client_id: "https://client.test/oauth/client.json",
				scope: "mcp:invoke",
				iat: nowSeconds,
				nbf: nowSeconds,
				exp: nowSeconds + 900,
				jti: crypto.randomUUID(),
				...claims,
			});
		},
	};
}
