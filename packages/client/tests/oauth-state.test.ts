import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	McpOAuthStateError,
	McpOAuthStateErrorCode,
	createOAuthState,
	createOAuthStateLookupDigest,
	createPkceS256Challenge,
	createPkceVerifier,
	parseOAuthCallbackParameters,
	validateOAuthState,
} from "../src/oauth/state.ts";

describe("OAuth state", () => {
	it("generates bounded base64url state from a CSPRNG", () => {
		const states = new Set(Array.from({ length: 32 }, () => createOAuthState()));
		expect(states.size).toBe(32);
		for (const state of states) {
			expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		}

		expect(createOAuthState({ entropyBytes: 16 })).toMatch(/^[A-Za-z0-9_-]{22}$/u);
		expect(createOAuthState({ entropyBytes: 64 })).toMatch(/^[A-Za-z0-9_-]{86}$/u);
	});

	it.each([0, 15, 65, 32.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid state entropy byte count %s",
		(entropyBytes) => {
			expect(() => createOAuthState({ entropyBytes })).toThrowError(
				expect.objectContaining({ code: McpOAuthStateErrorCode.InvalidOptions }),
			);
		},
	);

	it("derives a stable, domain-separated SHA-256 lookup digest", () => {
		const state = "A".repeat(43);
		const digest = createOAuthStateLookupDigest(state);
		const independentlyDerived = createHash("sha256")
			.update("nest-mcp.client.oauth-state.v1\u0000", "utf8")
			.update(state, "utf8")
			.digest("base64url");
		const unscopedDigest = createHash("sha256").update(state, "utf8").digest("base64url");

		expect(digest).toBe(independentlyDerived);
		expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(digest).not.toBe(unscopedDigest);
	});

	it("validates only against a digest and accepts a live transaction", () => {
		const state = createOAuthState();
		expect(() =>
			validateOAuthState({
				actualState: state,
				expectedDigest: createOAuthStateLookupDigest(state),
				createdAtMs: 10_000,
				ttlMs: 5_000,
				nowMs: 14_999,
			}),
		).not.toThrow();
	});

	it("uses secret-free mismatch and digest errors", () => {
		const actualState = "A".repeat(43);
		const expectedState = "B".repeat(43);
		const expectedDigest = createOAuthStateLookupDigest(expectedState);

		let mismatch: unknown;
		try {
			validateOAuthState({
				actualState,
				expectedDigest,
				createdAtMs: 1,
				ttlMs: 1_000,
				nowMs: 2,
			});
		} catch (error) {
			mismatch = error;
		}
		expect(mismatch).toBeInstanceOf(McpOAuthStateError);
		expect(mismatch).toMatchObject({ code: McpOAuthStateErrorCode.StateMismatch });
		expect(String(mismatch)).not.toContain(actualState);
		expect(String(mismatch)).not.toContain(expectedState);
		expect(String(mismatch)).not.toContain(expectedDigest);

		const invalidDigest = `not-a-digest-${"marker".repeat(10)}`;
		let malformed: unknown;
		try {
			validateOAuthState({
				actualState,
				expectedDigest: invalidDigest,
				createdAtMs: 1,
				ttlMs: 1_000,
				nowMs: 2,
			});
		} catch (error) {
			malformed = error;
		}
		expect(malformed).toMatchObject({ code: McpOAuthStateErrorCode.InvalidDigest });
		expect(String(malformed)).not.toContain(invalidDigest);
	});

	it("rejects expired and future-created transactions at exact boundaries", () => {
		const state = createOAuthState();
		const expectedDigest = createOAuthStateLookupDigest(state);
		const base = { actualState: state, expectedDigest, createdAtMs: 10_000, ttlMs: 5_000 };

		expect(() => validateOAuthState({ ...base, nowMs: 15_000 })).toThrowError(
			expect.objectContaining({ code: McpOAuthStateErrorCode.StateExpired }),
		);
		expect(() => validateOAuthState({ ...base, nowMs: 9_999 })).toThrowError(
			expect.objectContaining({ code: McpOAuthStateErrorCode.StateNotYetValid }),
		);
	});

	it.each([
		{ createdAtMs: -1, ttlMs: 1, nowMs: 0 },
		{ createdAtMs: 0, ttlMs: 0, nowMs: 0 },
		{ createdAtMs: 0, ttlMs: -1, nowMs: 0 },
		{ createdAtMs: 0, ttlMs: 1.5, nowMs: 0 },
		{ createdAtMs: 0, ttlMs: 1, nowMs: Number.NaN },
	])("rejects invalid lifetime input %#", (lifetime) => {
		const state = createOAuthState();
		expect(() =>
			validateOAuthState({
				actualState: state,
				expectedDigest: createOAuthStateLookupDigest(state),
				...lifetime,
			}),
		).toThrowError(expect.objectContaining({ code: McpOAuthStateErrorCode.InvalidOptions }));
	});
});

describe("OAuth callback parameters", () => {
	it("parses a successful URL callback and preserves opaque values", () => {
		const state = createOAuthState();
		const callback = new URL("https://client.example.test/oauth/callback");
		callback.searchParams.set("code", "opaque.authorization-code");
		callback.searchParams.set("state", state);
		callback.searchParams.set("iss", "https://issuer.example.test/tenant");
		callback.searchParams.set("extension_parameter", "ignored");

		expect(parseOAuthCallbackParameters(callback)).toEqual({
			kind: "success",
			code: "opaque.authorization-code",
			state,
			issuer: "https://issuer.example.test/tenant",
		});
	});

	it("parses an error callback without exposing remote display text or links", () => {
		const state = createOAuthState();
		const parameters = new URLSearchParams({
			error: "access_denied",
			error_description: "remote-display-text-marker",
			error_uri: "javascript:remote-link-marker",
			state,
			iss: "https://issuer.example.test",
		});

		expect(parseOAuthCallbackParameters(parameters)).toEqual({
			kind: "error",
			error: "access_denied",
			state,
			issuer: "https://issuer.example.test",
		});
	});

	it.each(["code", "state", "iss", "error", "error_description", "error_uri"])(
		"rejects duplicate reserved parameter %s",
		(name) => {
			const marker = `sensitive-${name}-marker`;
			const parameters = new URLSearchParams({ code: "code", state: createOAuthState() });
			parameters.append(name, marker);
			parameters.append(name, marker);

			expectSecretFreeInvalidCallback(parameters, marker);
		},
	);

	it.each([
		new URLSearchParams({ state: createOAuthState() }),
		new URLSearchParams({ code: "code" }),
		new URLSearchParams({ code: "code", error: "access_denied", state: createOAuthState() }),
		new URLSearchParams({
			code: "code",
			error_description: "description",
			state: createOAuthState(),
		}),
		new URLSearchParams({ error_description: "description", state: createOAuthState() }),
	])("rejects missing or ambiguous callback cases", (parameters) => {
		expect(() => parseOAuthCallbackParameters(parameters)).toThrowError(
			expect.objectContaining({ code: McpOAuthStateErrorCode.InvalidCallback }),
		);
	});

	it.each([
		["code", ""],
		["state", ""],
		["iss", ""],
		["code", `marker\nvalue`],
		["state", `marker\u0000value`],
		["iss", `marker\rvalue`],
		["code", "x".repeat(4_097)],
		["state", "x".repeat(513)],
		["iss", "x".repeat(2_049)],
	] as const)("rejects empty, control-containing, or oversized %s", (name, value) => {
		const parameters = new URLSearchParams({ code: "code", state: createOAuthState() });
		parameters.set(name, value);
		expectSecretFreeInvalidCallback(parameters, value);
	});

	it("rejects fragment-bearing callback URLs", () => {
		const callback = new URL("https://client.example.test/callback");
		callback.searchParams.set("code", "code");
		callback.searchParams.set("state", createOAuthState());
		callback.hash = "#code=fragment-secret";

		expectSecretFreeInvalidCallback(callback, "fragment-secret");
	});
});

describe("PKCE", () => {
	it("generates a bounded verifier and derives the RFC 7636 S256 vector", () => {
		expect(createPkceVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(createPkceVerifier({ entropyBytes: 96 })).toMatch(/^[A-Za-z0-9_-]{128}$/u);

		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		expect(createPkceS256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it.each(["short", "x".repeat(129), `${"x".repeat(42)}!`])(
		"rejects an invalid PKCE verifier without reflecting it",
		(verifier) => {
			let thrown: unknown;
			try {
				createPkceS256Challenge(verifier);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({ code: McpOAuthStateErrorCode.InvalidPkceVerifier });
			expect(String(thrown)).not.toContain(verifier);
		},
	);

	it.each([0, 31, 97, 32.5])("rejects invalid PKCE entropy byte count %s", (entropyBytes) => {
		expect(() => createPkceVerifier({ entropyBytes })).toThrowError(
			expect.objectContaining({ code: McpOAuthStateErrorCode.InvalidOptions }),
		);
	});
});

function expectSecretFreeInvalidCallback(input: URL | URLSearchParams, marker: string): void {
	let thrown: unknown;
	try {
		parseOAuthCallbackParameters(input);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(McpOAuthStateError);
	expect(thrown).toMatchObject({ code: McpOAuthStateErrorCode.InvalidCallback });
	if (marker.length > 0) expect(String(thrown)).not.toContain(marker);
}
