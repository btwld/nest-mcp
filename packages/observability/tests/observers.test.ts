import { createMcpOperationContext } from "@nest-mcp/core";
import { describe, expect, it, vi } from "vitest";

import { createMcpLoggerObserver } from "../src/logging.ts";
import { createMcpMetricsObserver } from "../src/metrics.ts";
import type { McpOperationFailedEvent, McpOperationSucceededEvent } from "@nest-mcp/core";
import type { McpMetricMeasurement } from "../src/metrics.ts";

function makeContext() {
	return createMcpOperationContext({
		operationId: "operation-id-secret",
		requestId: "request-id-secret",
		sessionId: "session-id-secret",
		principal: { token: "principal-token-secret" },
		role: "server",
		operation: { name: "resources/read", kind: "request", capability: "resources" },
	});
}

describe("createMcpLoggerObserver", () => {
	it("writes a safe structured failure without the raw error or identifiers", async () => {
		const write = vi.fn();
		const observer = createMcpLoggerObserver({ write });
		const event = {
			type: "operation.failed",
			timestamp: 100,
			durationMs: 12,
			context: makeContext(),
			error: {
				name: "UpstreamError",
				message: "Bearer raw-error-token failed",
				code: "UPSTREAM_UNAVAILABLE",
			},
		} satisfies McpOperationFailedEvent;

		await observer.onEvent(event);

		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "error",
				event: "operation.failed",
				message: "MCP operation failed",
				attributes: expect.objectContaining({
					"mcp.operation.outcome": "error",
					"error.type": "UpstreamError",
					"error.code": "UPSTREAM_UNAVAILABLE",
				}),
			}),
		);
		expect(JSON.stringify(write.mock.calls)).not.toMatch(
			/raw-error-token|operation-id-secret|request-id-secret|session-id-secret|principal-token-secret/,
		);
	});

	it("supports explicit bounded dimensions and event suppression", async () => {
		const write = vi.fn();
		const observer = createMcpLoggerObserver(
			{ write },
			{
				levels: { "operation.succeeded": false },
				selectAttributes: () => ({ "tenant.bucket": "enterprise" }),
			},
		);
		const event = {
			type: "operation.succeeded",
			timestamp: 100,
			durationMs: 12,
			context: makeContext(),
		} satisfies McpOperationSucceededEvent;

		await observer.onEvent(event);
		expect(write).not.toHaveBeenCalled();
	});
});

describe("createMcpMetricsObserver", () => {
	it("emits batched completion, active, and duration measurements", async () => {
		const batches: (readonly McpMetricMeasurement[])[] = [];
		const record = vi.fn((measurements: readonly McpMetricMeasurement[]) => {
			batches.push(measurements);
		});
		const observer = createMcpMetricsObserver({ record });
		const event = {
			type: "operation.succeeded",
			timestamp: 125,
			durationMs: 25,
			context: makeContext(),
		} satisfies McpOperationSucceededEvent;

		await observer.onEvent(event);

		const measurements = batches[0] ?? [];
		expect(measurements.map(({ name, value }) => [name, value])).toEqual([
			["mcp.operation.completed", 1],
			["mcp.operation.active", -1],
			["mcp.operation.duration", 25],
		]);
		expect(measurements[0]?.attributes).toMatchObject({
			"mcp.operation.outcome": "success",
			"mcp.runtime.role": "server",
		});
		expect(measurements[1]?.attributes).not.toHaveProperty("mcp.operation.outcome");
		expect(JSON.stringify(measurements)).not.toMatch(
			/operation-id-secret|request-id-secret|session-id-secret|principal-token-secret/,
		);
	});
});
