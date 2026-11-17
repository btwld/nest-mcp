import { describe, expect, it, vi } from "vitest";

import {
	McpAuthorizationError,
	allowMcpOperation,
	createMcpAuthorizationMiddleware,
	denyMcpOperation,
	enforceMcpAuthorization,
} from "../src/authorization.ts";
import { composeMcpMiddleware } from "../src/middleware.ts";
import { createMcpOperation, createMcpOperationContext } from "../src/operation.ts";
import type { McpAuthorizationPolicy } from "../src/authorization.ts";

const operation = createMcpOperation(
	{ tool: "weather" },
	createMcpOperationContext({
		operationId: "authorization-op",
		role: "server",
		operation: { name: "tools/call", kind: "request" },
		principal: { subject: "user-1" },
	}),
);

describe("authorization", () => {
	it("returns an explicit allow decision", async () => {
		const decision = allowMcpOperation({ policy: "tool-access", reason: "member" });
		const policy: McpAuthorizationPolicy<{ tool: string }> = { authorize: () => decision };

		await expect(enforceMcpAuthorization(policy, operation)).resolves.toEqual(decision);
		expect(Object.isFrozen(decision)).toBe(true);
	});

	it("raises a typed error for an explicit deny", async () => {
		const policy: McpAuthorizationPolicy<{ tool: string }> = {
			authorize: () => denyMcpOperation("Tool is not assigned.", { policy: "tool-access" }),
		};

		const rejection = enforceMcpAuthorization(policy, operation);
		await expect(rejection).rejects.toMatchObject({
			code: "MCP_AUTHORIZATION_DENIED",
			failure: "denied",
			operationId: "authorization-op",
		});
		await expect(rejection).rejects.toBeInstanceOf(McpAuthorizationError);
	});

	it.each([
		["missing-policy", undefined],
		[
			"policy-error",
			{
				authorize: (): Promise<never> => Promise.reject(new Error("identity provider unavailable")),
			},
		],
		[
			"invalid-decision",
			{
				// Intentionally models an untyped JavaScript policy crossing the package boundary.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				authorize: (): never => undefined as never,
			},
		],
	] as const)("fails closed for %s", async (failure, policy) => {
		await expect(
			enforceMcpAuthorization(
				policy as McpAuthorizationPolicy<{ tool: string }> | undefined,
				operation,
			),
		).rejects.toMatchObject({ failure });
	});

	it("prevents the terminal handler from running after denial", async () => {
		const terminal = vi.fn(() => "secret result");
		const pipeline = composeMcpMiddleware(
			[
				createMcpAuthorizationMiddleware<{ tool: string }, string>({
					authorize: () => denyMcpOperation("Denied."),
				}),
			],
			terminal,
		);

		await expect(pipeline(operation)).rejects.toBeInstanceOf(McpAuthorizationError);
		expect(terminal).not.toHaveBeenCalled();
	});
});
