import { describe, expect, it } from "vitest";

import {
	MCP_CLIENT_OAUTH_MAX_SCOPE_LENGTH,
	isMcpClientOAuthScopeToken,
} from "../src/oauth/scope.ts";

describe("isMcpClientOAuthScopeToken", () => {
	it.each(["!", "#", "[", "]", "~", "urn:x,a", "tools:read"])(
		"accepts RFC 6749 NQCHAR token %j",
		(value) => {
			expect(isMcpClientOAuthScopeToken(value)).toBe(true);
		},
	);

	it.each(["", 'scope"quote', "scope\\slash", "scope space", "scope\tcontrol", "café"])(
		"rejects non-NQCHAR token %j",
		(value) => {
			expect(isMcpClientOAuthScopeToken(value)).toBe(false);
		},
	);

	it("enforces the facade's scope-token bound", () => {
		expect(isMcpClientOAuthScopeToken("a".repeat(MCP_CLIENT_OAUTH_MAX_SCOPE_LENGTH))).toBe(true);
		expect(isMcpClientOAuthScopeToken("a".repeat(MCP_CLIENT_OAUTH_MAX_SCOPE_LENGTH + 1))).toBe(
			false,
		);
	});
});
