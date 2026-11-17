import { describe, expect, it } from "vitest";

import { createMcpOperation, createMcpOperationContext } from "../src/operation.ts";

describe("operation context", () => {
	it("copies and freezes metadata used across runtime boundaries", () => {
		const dimensions = ["trusted", "bounded"];
		const operationAttributes = { capabilityVersion: 2, dimensions };
		const contextAttributes = { tenant: "acme" };
		const context = createMcpOperationContext({
			operationId: "op-1",
			requestId: "request-1",
			role: "gateway",
			operation: {
				name: "tools/call",
				kind: "request",
				capability: "tools",
				attributes: operationAttributes,
			},
			attributes: contextAttributes,
		});

		operationAttributes.capabilityVersion = 3;
		dimensions.push("mutated");
		contextAttributes.tenant = "other";

		expect(context.operation.attributes).toEqual({
			capabilityVersion: 2,
			dimensions: ["trusted", "bounded"],
		});
		expect(context.attributes).toEqual({ tenant: "acme" });
		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.operation)).toBe(true);
		expect(Object.isFrozen(context.attributes)).toBe(true);
		expect(Object.isFrozen(context.operation.attributes.dimensions)).toBe(true);
		expect(context.signal.aborted).toBe(false);
	});

	it("creates an immutable envelope without cloning its input", () => {
		const input = { name: "weather" };
		const context = createMcpOperationContext({
			operationId: "op-2",
			role: "client",
			operation: { name: "tools/list", kind: "request" },
		});
		const operation = createMcpOperation(input, context);

		expect(operation.input).toBe(input);
		expect(Object.isFrozen(operation)).toBe(true);
	});

	it.each([
		["operationId", { operationId: "" }],
		["operation.name", { operation: { name: "   ", kind: "request" as const } }],
	])("rejects an empty %s", (_field, override) => {
		expect(() =>
			createMcpOperationContext({
				operationId: "op-3",
				role: "server",
				operation: { name: "resources/read", kind: "request" },
				...override,
			}),
		).toThrow(TypeError);
	});

	it("rejects malformed runtime metadata even when called from JavaScript", () => {
		expect(() =>
			createMcpOperationContext({
				operationId: "op-4",
				// Intentionally models malformed JavaScript input at the runtime boundary.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				role: "proxy" as "gateway",
				operation: { name: "tools/list", kind: "request" },
			}),
		).toThrow("role must be client, server, or gateway");

		expect(() =>
			createMcpOperationContext({
				operationId: "op-5",
				role: "gateway",
				operation: {
					name: "tools/list",
					kind: "request",
					// Intentionally models malformed JavaScript input at the runtime boundary.
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion
					attributes: [] as never,
				},
			}),
		).toThrow("attributes must be a record");

		expect(() =>
			createMcpOperationContext({
				operationId: "op-6",
				role: "gateway",
				operation: { name: "tools/list", kind: "request" },
				// Intentionally models a mutable structured value from JavaScript.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				attributes: { nested: { mutable: true } } as unknown as Readonly<Record<string, string>>,
			}),
		).toThrow("attributes.nested must be a scalar or scalar array");
	});
});
