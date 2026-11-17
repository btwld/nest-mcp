import { describe, expect, it } from "vitest";

import {
	McpMiddlewareReentryError,
	composeMcpMiddleware,
	createMcpPassthroughMiddleware,
} from "../src/middleware.ts";
import { createMcpOperation, createMcpOperationContext } from "../src/operation.ts";
import type { McpOperationMiddleware } from "../src/operation.ts";

const operation = createMcpOperation(
	{ value: 1 },
	createMcpOperationContext({
		operationId: "middleware-op",
		role: "gateway",
		operation: { name: "tools/call", kind: "request" },
	}),
);

describe("composeMcpMiddleware", () => {
	it("runs middleware in onion order", async () => {
		const calls: string[] = [];
		const first: McpOperationMiddleware<{ value: number }, number> = async (_operation, next) => {
			calls.push("first:before");
			const result = await next();
			calls.push("first:after");
			return result + 1;
		};
		const second: McpOperationMiddleware<{ value: number }, number> = async (_operation, next) => {
			calls.push("second:before");
			const result = await next();
			calls.push("second:after");
			return result * 2;
		};
		const pipeline = composeMcpMiddleware([first, second], ({ input }) => {
			calls.push("terminal");
			return input.value;
		});

		await expect(pipeline(operation)).resolves.toBe(3);
		expect(calls).toEqual([
			"first:before",
			"second:before",
			"terminal",
			"second:after",
			"first:after",
		]);
	});

	it("rejects a second next call", async () => {
		const pipeline = composeMcpMiddleware(
			[
				async (_operation, next) => {
					await next();
					return next();
				},
			],
			() => 1,
		);

		await expect(pipeline(operation)).rejects.toBeInstanceOf(McpMiddlewareReentryError);
	});

	it("snapshots the middleware list and isolates concurrent invocations", async () => {
		const source: McpOperationMiddleware<{ value: number }, number>[] = [
			async (_operation, next) => next(),
		];
		const pipeline = composeMcpMiddleware(source, ({ input }) => input.value);
		source.push(() => 99);

		await expect(Promise.all([pipeline(operation), pipeline(operation)])).resolves.toEqual([1, 1]);
	});

	it("keeps passthrough middleware result-opaque and returns the exact downstream value", async () => {
		const calls: string[] = [];
		const expected = Object.freeze({ content: [] });
		const passthrough = createMcpPassthroughMiddleware<{ value: number }, typeof expected>(
			async (_operation, next) => {
				calls.push("before");
				await next();
				calls.push("after");
			},
		);
		const pipeline = composeMcpMiddleware([passthrough], () => expected);

		await expect(pipeline(operation)).resolves.toBe(expected);
		expect(calls).toEqual(["before", "after"]);
	});

	it("rejects passthrough middleware that completes without calling next", async () => {
		const passthrough = createMcpPassthroughMiddleware<{ value: number }, number>(() => {});
		const pipeline = composeMcpMiddleware([passthrough], () => 1);

		await expect(pipeline(operation)).rejects.toThrow(
			"Passthrough MCP middleware must call next().",
		);
	});

	it("does not let passthrough middleware swallow a downstream failure", async () => {
		const failure = new Error("downstream failed");
		const passthrough = createMcpPassthroughMiddleware<{ value: number }, number>(
			async (_operation, next) => {
				try {
					await next();
				} catch {
					// The adapter still owns the rejected downstream task.
				}
			},
		);
		const pipeline = composeMcpMiddleware([passthrough], () => Promise.reject(failure));

		await expect(pipeline(operation)).rejects.toBe(failure);
	});
});
