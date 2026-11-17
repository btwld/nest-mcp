import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createMcpTokenKeyRing,
	generateMcpSigningKey,
	McpAccessTokenError,
	signMcpAccessToken,
	verifyMcpAccessToken,
} from "../src/index.ts";
import type { McpAccessTokenClaims } from "../src/index.ts";

const ISSUER = "https://mcp.example.com";

function claims(overrides?: Partial<McpAccessTokenClaims>): McpAccessTokenClaims {
	const now = Math.floor(Date.now() / 1_000);
	return {
		iss: ISSUER,
		aud: "https://mcp.example.com/mcp",
		sub: "u_abc",
		client_id: "https://client.example/oauth/client.json",
		scope: "mcp:invoke files:read",
		iat: now,
		nbf: now,
		exp: now + 900,
		jti: crypto.randomUUID(),
		...overrides,
	};
}

describe("MCP access-token issuing and verification", () => {
	it.each(["EdDSA", "ES256"] as const)("round-trips %s tokens", (alg) => {
		const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey(alg)] });
		const token = signMcpAccessToken(ring, claims());
		const verified = verifyMcpAccessToken(ring, token, { issuer: ISSUER });
		expect(verified.scope).toBe("mcp:invoke files:read");
		expect(verified.aud).toBe("https://mcp.example.com/mcp");
	});

	it("round-trips HS256 tokens with a sufficiently long secret", () => {
		const ring = createMcpTokenKeyRing({
			keys: [{ alg: "HS256", secret: randomBytes(32) }],
		});
		const token = signMcpAccessToken(ring, claims());
		expect(verifyMcpAccessToken(ring, token, { issuer: ISSUER }).sub).toBe("u_abc");
	});

	it("rejects HS256 secrets shorter than 32 bytes", () => {
		expect(() =>
			createMcpTokenKeyRing({ keys: [{ alg: "HS256", secret: randomBytes(16) }] }),
		).toThrowError(/at least 32 bytes/);
	});

	it("pins the algorithm from the resolved key, not the token header", () => {
		// Sign with an HS256 ring, present to an EdDSA ring whose key claims the same kid.
		const eddsa = generateMcpSigningKey("EdDSA");
		const verifyRing = createMcpTokenKeyRing({ keys: [{ ...eddsa, kid: "shared-kid" }] });
		const attackRing = createMcpTokenKeyRing({
			keys: [{ alg: "HS256", secret: randomBytes(32), kid: "shared-kid" }],
		});
		const forged = signMcpAccessToken(attackRing, claims());
		expect(() => verifyMcpAccessToken(verifyRing, forged, { issuer: ISSUER })).toThrowError(
			McpAccessTokenError,
		);
	});

	it("rejects alg:none tokens", () => {
		const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey()] });
		const header = Buffer.from(
			JSON.stringify({ alg: "none", typ: "at+jwt", kid: ring.activeKey().kid }),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims())).toString("base64url");
		expect(() =>
			verifyMcpAccessToken(ring, `${header}.${payload}.`, { issuer: ISSUER }),
		).toThrowError(McpAccessTokenError);
	});

	it("rejects unknown kids and non-access-token typ values", () => {
		const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey()] });
		const other = createMcpTokenKeyRing({ keys: [generateMcpSigningKey()] });
		const foreign = signMcpAccessToken(other, claims());
		expect(() => verifyMcpAccessToken(ring, foreign, { issuer: ISSUER })).toThrowError(
			/not in the verification ring/,
		);
		const key = ring.activeKey();
		const header = Buffer.from(JSON.stringify({ alg: key.alg, typ: "JWT", kid: key.kid })).toString(
			"base64url",
		);
		const payload = Buffer.from(JSON.stringify(claims())).toString("base64url");
		const signature = key.sign(Buffer.from(`${header}.${payload}`)).toString("base64url");
		expect(() =>
			verifyMcpAccessToken(ring, `${header}.${payload}.${signature}`, { issuer: ISSUER }),
		).toThrowError(/not an at\+jwt/);
	});

	it("enforces exp and nbf with bounded skew", () => {
		const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey()] });
		const now = Math.floor(Date.now() / 1_000);
		const expired = signMcpAccessToken(ring, claims({ exp: now - 300 }));
		expect(() => verifyMcpAccessToken(ring, expired, { issuer: ISSUER })).toThrowError(/expired/);
		const future = signMcpAccessToken(ring, claims({ nbf: now + 600 }));
		expect(() => verifyMcpAccessToken(ring, future, { issuer: ISSUER })).toThrowError(
			/not yet valid/,
		);
		// Requested skew above the two-minute bound is clamped.
		expect(() =>
			verifyMcpAccessToken(ring, future, { issuer: ISSUER, clockSkewSeconds: 3_600 }),
		).toThrowError(/not yet valid/);
	});

	it("rejects issuer mismatches without normalization", () => {
		const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey()] });
		const token = signMcpAccessToken(ring, claims());
		expect(() => verifyMcpAccessToken(ring, token, { issuer: `${ISSUER}/` })).toThrowError(
			/issuer/,
		);
	});

	it("publishes only public JWKS members and keeps kids unique", () => {
		const first = generateMcpSigningKey("EdDSA");
		const second = generateMcpSigningKey("ES256");
		const ring = createMcpTokenKeyRing({
			keys: [first, second, { alg: "HS256", secret: randomBytes(32) }],
		});
		const jwks = ring.publicJwks();
		expect(jwks.keys).toHaveLength(2);
		for (const key of jwks.keys) {
			expect(key).not.toHaveProperty("d");
			expect(key).not.toHaveProperty("k");
			expect(key).not.toHaveProperty("p");
			expect(key).not.toHaveProperty("q");
			expect(typeof key["kid"]).toBe("string");
		}
		expect(() =>
			createMcpTokenKeyRing({
				keys: [
					{ ...first, kid: "dup" },
					{ ...second, kid: "dup" },
				],
			}),
		).toThrowError(/unique/);
	});
});
