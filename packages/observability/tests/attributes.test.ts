import { createMcpOperationContext } from "@nest-mcp/core";
import { describe, expect, it } from "vitest";

import { MCP_TELEMETRY_HARD_LIMITS, projectMcpTelemetryAttributes } from "../src/attributes.ts";

function makeContext() {
	return createMcpOperationContext({
		operationId: "operation-secret-id",
		requestId: "request-secret-id",
		sessionId: "session-secret-id",
		principal: { subject: "principal-secret" },
		role: "gateway",
		operation: {
			name: "tools/call",
			kind: "request",
			capability: "tools",
			target: "catalog",
			attributes: { authorization: "Bearer operation-token" },
		},
		attributes: { cookie: "session=cookie-secret", tenant: "unselected" },
	});
}

describe("projectMcpTelemetryAttributes", () => {
	it("emits only bounded low-cardinality MCP dimensions by default", () => {
		const attributes = projectMcpTelemetryAttributes(makeContext());

		expect(attributes).toEqual({
			"mcp.operation.capability": "tools",
			"mcp.operation.kind": "request",
			"mcp.operation.name": "tools/call",
			"mcp.operation.target": "catalog",
			"mcp.runtime.role": "gateway",
		});
		expect(JSON.stringify(attributes)).not.toMatch(
			/operation-secret|request-secret|session-secret|principal-secret|Bearer|cookie-secret/,
		);
		expect(Object.isFrozen(attributes)).toBe(true);
	});

	it("bounds selected attributes and drops unsafe keys and values", () => {
		const attributes = projectMcpTelemetryAttributes(makeContext(), {
			maxAttributes: 7,
			maxStringLength: 5,
			selectAttributes: () => {
				// Intentionally models malformed JavaScript selector output.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				return {
					"a.dimension": "abcdefgh",
					"b.dimension": 4,
					"c.dimension": "excluded by count",
					access_token: "raw-token",
					requestId: "raw-request-id",
					unsupported: { nested: true },
				} as never;
			},
		});

		expect(attributes).toMatchObject({
			"mcp.operation.name": "tools",
			"a.dimension": "abcde",
			"b.dimension": 4,
		});
		expect(attributes).not.toHaveProperty("access_token");
		expect(attributes).not.toHaveProperty("requestId");
		expect(attributes).not.toHaveProperty("unsupported");
		expect(Object.keys(attributes)).toHaveLength(7);
	});

	it("requires explicit sensitive-key opt-in and supports redaction or removal", () => {
		const attributes = projectMcpTelemetryAttributes(makeContext(), {
			selectAttributes: () => ({ requestId: "raw-request-id", tenant: "acme" }),
			allowSensitiveAttribute: ({ key }) => key === "requestId",
			redactAttribute: ({ key, value }) => {
				if (key === "requestId") return "hashed-request-bucket";
				if (key === "tenant") return undefined;
				return typeof value === "string" ? value : undefined;
			},
		});

		expect(attributes.requestId).toBe("hashed-request-bucket");
		expect(attributes).not.toHaveProperty("tenant");
		expect(JSON.stringify(attributes)).not.toContain("raw-request-id");
	});

	it.each([
		"token.value",
		"oauth.token",
		"api_token_value",
		"client.key",
		"authorizationCode",
		"pkceVerifier",
	])("drops the sensitive-looking selected key %s without an explicit opt-in", (key) => {
		const attributes = projectMcpTelemetryAttributes(makeContext(), {
			selectAttributes: () => ({ [key]: "secret-value", "safe.bucket": "stable" }),
		});

		expect(attributes).not.toHaveProperty(key);
		expect(attributes["safe.bucket"]).toBe("stable");
	});

	it("rejects limits that could make attribute sets unbounded", () => {
		expect(() =>
			projectMcpTelemetryAttributes(makeContext(), {
				maxAttributes: MCP_TELEMETRY_HARD_LIMITS.maxAttributes + 1,
			}),
		).toThrow(RangeError);
	});
});
