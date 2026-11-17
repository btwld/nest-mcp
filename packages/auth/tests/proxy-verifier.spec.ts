import { OAuthError } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpProxyTokenVerifier } from "../src/index.ts";
import { createMcpTestKeyRing } from "../src/testing/index.ts";

const ISSUER = "https://issuer.test";
const RESOURCE = "https://mcp.example.com/mcp";

describe("createMcpProxyTokenVerifier", () => {
	it("projects verified claims onto AuthInfo with the allowlisted extras only", async () => {
		const { ring, mintAccessToken } = createMcpTestKeyRing();
		const verifier = createMcpProxyTokenVerifier({ ring, issuer: ISSUER, resources: [RESOURCE] });
		const token = mintAccessToken({ aud: RESOURCE, tid: "tenant-1" });

		const authInfo = await verifier.verifyAccessToken(token);
		expect(authInfo.clientId).toBe("https://client.test/oauth/client.json");
		expect(authInfo.scopes).toEqual(["mcp:invoke"]);
		expect(typeof authInfo.expiresAt).toBe("number");
		expect(authInfo.resource?.href).toBe(RESOURCE);
		const claims = authInfo.extra?.["claims"];
		expect(claims).toEqual({ sub: "user-test", tid: "tenant-1" });
		expect(Object.isFrozen(claims)).toBe(true);
	});

	it("rejects tokens whose audience is a sibling resource", async () => {
		const { ring, mintAccessToken } = createMcpTestKeyRing();
		const verifier = createMcpProxyTokenVerifier({ ring, issuer: ISSUER, resources: [RESOURCE] });
		const token = mintAccessToken({ aud: "https://mcp.example.com/other" });
		await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
	});

	it("accepts audiences scoped below a configured resource prefix", async () => {
		const { ring, mintAccessToken } = createMcpTestKeyRing();
		const verifier = createMcpProxyTokenVerifier({
			ring,
			issuer: ISSUER,
			resources: ["https://mcp.example.com/mcp"],
		});
		const token = mintAccessToken({ aud: "https://mcp.example.com/mcp/tenant-a" });
		await expect(verifier.verifyAccessToken(token)).resolves.toBeDefined();
	});

	it("consults the revocation hook", async () => {
		const { ring, mintAccessToken } = createMcpTestKeyRing();
		const revoked = new Set<string>();
		const verifier = createMcpProxyTokenVerifier({
			ring,
			issuer: ISSUER,
			resources: [RESOURCE],
			isRevoked: (jti) => revoked.has(jti),
		});
		const token = mintAccessToken({ aud: RESOURCE, jti: "revoked-jti" });
		await expect(verifier.verifyAccessToken(token)).resolves.toBeDefined();
		revoked.add("revoked-jti");
		await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
	});

	it("rejects garbage, forged, and wrong-issuer tokens with the same generic error", async () => {
		const { ring, mintAccessToken } = createMcpTestKeyRing();
		const verifier = createMcpProxyTokenVerifier({ ring, issuer: ISSUER, resources: [RESOURCE] });
		const foreign = createMcpTestKeyRing({ issuer: "https://other.test" });
		const cases = [
			"not-a-token",
			"a.b.c",
			foreign.mintAccessToken({ aud: RESOURCE }),
			mintAccessToken({ aud: RESOURCE, iss: "https://issuer.test/" }),
		];
		for (const token of cases) {
			await expect(verifier.verifyAccessToken(token)).rejects.toThrowError(/Invalid access token/);
		}
	});

	it("requires at least one configured resource", () => {
		const { ring } = createMcpTestKeyRing();
		expect(() => createMcpProxyTokenVerifier({ ring, issuer: ISSUER, resources: [] })).toThrowError(
			/at least one resource/,
		);
	});
});
