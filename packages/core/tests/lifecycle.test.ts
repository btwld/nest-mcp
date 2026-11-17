import { describe, expect, it, vi } from "vitest";

import {
	composeMcpLifecycleObservers,
	createMcpLifecycleMiddleware,
	toMcpErrorDetails,
} from "../src/lifecycle.ts";
import { composeMcpMiddleware } from "../src/middleware.ts";
import { createMcpOperation, createMcpOperationContext } from "../src/operation.ts";
import type { McpLifecycleEvent, McpLifecycleObserver } from "../src/lifecycle.ts";

function makeOperation(signal?: AbortSignal) {
	return createMcpOperation(
		{ secret: "not emitted" },
		createMcpOperationContext({
			operationId: "lifecycle-op",
			role: "client",
			operation: { name: "resources/read", kind: "request" },
			...(signal === undefined ? {} : { signal }),
		}),
	);
}

describe("lifecycle middleware", () => {
	it("emits structured success events without payloads", async () => {
		const events: McpLifecycleEvent[] = [];
		const observer: McpLifecycleObserver = {
			onEvent: (event) => {
				events.push(event);
			},
		};
		const timestamps = [100, 125];
		const pipeline = composeMcpMiddleware(
			[
				createMcpLifecycleMiddleware(observer, {
					now: () => timestamps.shift() ?? 125,
				}),
			],
			() => "result",
		);

		await expect(pipeline(makeOperation())).resolves.toBe("result");
		expect(events.map(({ type }) => type)).toEqual(["operation.started", "operation.succeeded"]);
		expect(events[1]).toMatchObject({ durationMs: 25, timestamp: 125 });
		expect(events.every((event) => !("input" in event) && !("output" in event))).toBe(true);
	});

	it("emits a serialized failure and preserves the original error", async () => {
		const events: McpLifecycleEvent[] = [];
		const failure = Object.assign(new Error("upstream disconnected"), { code: "ECONNRESET" });
		const pipeline = composeMcpMiddleware(
			[
				createMcpLifecycleMiddleware(
					{
						onEvent: (event) => {
							events.push(event);
						},
					},
					{ now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(14) },
				),
			],
			() => {
				throw failure;
			},
		);

		await expect(pipeline(makeOperation())).rejects.toBe(failure);
		expect(events[1]).toMatchObject({
			type: "operation.failed",
			durationMs: 4,
			error: { name: "Error", message: "upstream disconnected", code: "ECONNRESET" },
		});
	});

	it("classifies an aborted rejection as cancellation", async () => {
		const controller = new AbortController();
		const events: McpLifecycleEvent[] = [];
		const pipeline = composeMcpMiddleware(
			[
				createMcpLifecycleMiddleware({
					onEvent: (event) => {
						events.push(event);
					},
				}),
			],
			() => {
				controller.abort(new Error("caller cancelled"));
				throw controller.signal.reason;
			},
		);

		await expect(pipeline(makeOperation(controller.signal))).rejects.toThrow("caller cancelled");
		expect(events.at(-1)?.type).toBe("operation.cancelled");
	});

	it("reports observer errors without changing the operation result", async () => {
		const observerFailure = new Error("telemetry offline");
		const onObserverError = vi.fn();
		const pipeline = composeMcpMiddleware(
			[
				createMcpLifecycleMiddleware(
					{ onEvent: () => Promise.reject(observerFailure) },
					{ onObserverError },
				),
			],
			() => 42,
		);

		await expect(pipeline(makeOperation())).resolves.toBe(42);
		expect(onObserverError).toHaveBeenCalledTimes(2);
	});

	it("contains lifecycle clock failures", async () => {
		const events: McpLifecycleEvent[] = [];
		const pipeline = composeMcpMiddleware(
			[
				createMcpLifecycleMiddleware(
					{
						onEvent: (event) => {
							events.push(event);
						},
					},
					{
						now: () => {
							throw new Error("clock unavailable");
						},
					},
				),
			],
			() => 42,
		);

		await expect(pipeline(makeOperation())).resolves.toBe(42);
		expect(events.map(({ type }) => type)).toEqual(["operation.started", "operation.succeeded"]);
	});
});

describe("lifecycle observers", () => {
	it("attempts every observer before surfacing failures", async () => {
		const successful = vi.fn();
		const composite = composeMcpLifecycleObservers([
			{ onEvent: () => Promise.reject(new Error("first")) },
			{ onEvent: successful },
			{ onEvent: () => Promise.reject(new Error("third")) },
		]);
		const context = makeOperation().context;

		await expect(
			composite.onEvent({ type: "operation.started", timestamp: 1, context }),
		).rejects.toBeInstanceOf(AggregateError);
		expect(successful).toHaveBeenCalledOnce();
	});

	it("serializes non-Error throwables safely", () => {
		expect(toMcpErrorDetails("nope")).toEqual({ name: "Error", message: "nope" });
		expect(toMcpErrorDetails({ code: 503 })).toEqual({
			name: "UnknownError",
			message: "[object Object]",
			code: "503",
		});
	});
});
