import {
	composeMcpMiddleware,
	createMcpOperation,
	createMcpOperationContext,
} from "@nest-mcp/core";
import { describe, expect, it, vi } from "vitest";

import { createMcpTracingMiddleware } from "../src/tracing.ts";
import type { McpTraceSpan, McpTracer } from "../src/tracing.ts";

function makeOperation(signal?: AbortSignal) {
	return createMcpOperation(
		{ bearerToken: "payload-token-secret" },
		createMcpOperationContext({
			operationId: "operation-id-secret",
			requestId: "request-id-secret",
			sessionId: "session-id-secret",
			principal: { subject: "principal-secret" },
			role: "client",
			operation: { name: "tools/call", kind: "request", capability: "tools" },
			...(signal === undefined ? {} : { signal }),
		}),
	);
}

function makeSpan() {
	return {
		setAttributes: vi.fn<McpTraceSpan["setAttributes"]>(),
		setStatus: vi.fn<McpTraceSpan["setStatus"]>(),
		end: vi.fn<McpTraceSpan["end"]>(),
	} satisfies McpTraceSpan;
}

describe("createMcpTracingMiddleware", () => {
	it("records safe failure classification and preserves the original error", async () => {
		const span = makeSpan();
		const startSpan = vi.fn(() => span);
		const tracer: McpTracer = { startSpan };
		const timestamps = [10, 18];
		const failure = Object.assign(new Error("Bearer error-token-secret"), {
			code: "UPSTREAM_FAILED",
		});
		const pipeline = composeMcpMiddleware(
			[
				createMcpTracingMiddleware(tracer, {
					now: () => timestamps.shift() ?? 18,
				}),
			],
			() => Promise.reject(failure),
		);

		await expect(pipeline(makeOperation())).rejects.toBe(failure);
		expect(startSpan).toHaveBeenCalledWith(
			"mcp client tools/call",
			expect.objectContaining({ kind: "client", startTime: 10 }),
		);
		expect(span.setAttributes).toHaveBeenCalledWith(
			expect.objectContaining({
				"mcp.operation.outcome": "error",
				"error.type": "Error",
				"error.code": "UPSTREAM_FAILED",
			}),
		);
		expect(span.setStatus).toHaveBeenCalledWith({
			code: "error",
			description: "MCP operation failed",
		});
		expect(span.end).toHaveBeenCalledWith(18);
		expect(JSON.stringify(span.setAttributes.mock.calls)).not.toMatch(
			/error-token-secret|payload-token-secret|operation-id-secret|request-id-secret|session-id-secret|principal-secret/,
		);
	});

	it("contains tracer failures and still invokes the operation once", async () => {
		const onInstrumentationError = vi.fn();
		const terminal = vi.fn(() => 42);
		const pipeline = composeMcpMiddleware(
			[
				createMcpTracingMiddleware(
					{ startSpan: () => Promise.reject(new Error("tracer offline")) },
					{ onInstrumentationError },
				),
			],
			terminal,
		);

		await expect(pipeline(makeOperation())).resolves.toBe(42);
		expect(terminal).toHaveBeenCalledOnce();
		expect(onInstrumentationError).toHaveBeenCalledWith(
			expect.any(Error),
			"start",
			expect.any(Object),
		);
	});

	it("contains clock failures without changing a successful operation", async () => {
		const span = makeSpan();
		const onInstrumentationError = vi.fn();
		const terminal = vi.fn(() => "result");
		const pipeline = composeMcpMiddleware(
			[
				createMcpTracingMiddleware(
					{ startSpan: () => span },
					{
						now: () => {
							throw new Error("clock unavailable");
						},
						onInstrumentationError,
					},
				),
			],
			terminal,
		);

		await expect(pipeline(makeOperation())).resolves.toBe("result");
		expect(terminal).toHaveBeenCalledOnce();
		expect(span.end).toHaveBeenCalledOnce();
		expect(onInstrumentationError).toHaveBeenCalledWith(
			expect.any(Error),
			"clock",
			expect.any(Object),
		);
	});

	it("uses an activation adapter without allowing it to replace a completed result", async () => {
		const span = makeSpan();
		const onInstrumentationError = vi.fn();
		const terminal = vi.fn(() => "result");
		const tracer: McpTracer = {
			startSpan: () => span,
			withSpan: async (_span, callback) => {
				await callback();
				throw new Error("activation teardown failed");
			},
		};
		const pipeline = composeMcpMiddleware(
			[createMcpTracingMiddleware(tracer, { onInstrumentationError })],
			terminal,
		);

		await expect(pipeline(makeOperation())).resolves.toBe("result");
		expect(terminal).toHaveBeenCalledOnce();
		expect(onInstrumentationError).toHaveBeenCalledWith(
			expect.any(Error),
			"activate",
			expect.any(Object),
		);
	});
});
