import type { StandardSchemaV1 } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	MCP_RUNTIME_PHASES,
	MCP_RUNTIME_PROTOCOL_ERAS,
	mcpRuntimeCapabilitiesSnapshotSchema,
	mcpRuntimeProbeSnapshotSchema,
	mcpRuntimeStateSnapshotSchema,
	type McpRuntimeCapabilitiesSnapshot,
	type McpRuntimeProbeSnapshot,
	type McpRuntimeSnapshotSchema,
	type McpRuntimeStateSnapshot,
} from "../src/index.ts";

const CAPABILITIES: McpRuntimeCapabilitiesSnapshot = Object.freeze({
	tools: true,
	resources: true,
	prompts: false,
	completion: false,
	subscriptions: true,
});

const STATE: McpRuntimeStateSnapshot = Object.freeze({
	phase: "online",
	lastTransitionAt: "2026-01-01T00:00:00.000Z",
	protocolVersion: "2025-11-25",
	protocolEra: "modern",
	connectedAt: "2026-01-01T00:00:00.000Z",
	capabilities: CAPABILITIES,
});

const PROBE: McpRuntimeProbeSnapshot = Object.freeze({
	reachable: true,
	observedAt: "2026-01-01T00:00:01.000Z",
	protocolVersion: "2025-11-25",
	protocolEra: "modern",
	capabilities: CAPABILITIES,
	runtime: STATE,
});

describe("mcpRuntimeStateSnapshotSchema", () => {
	it("accepts a complete projection and returns a frozen normalized snapshot", () => {
		const value = accepted(mcpRuntimeStateSnapshotSchema, structuredClone(STATE));

		expect(value).toEqual(STATE);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.capabilities)).toBe(true);
	});

	it("accepts a minimal projection without inventing optional properties", () => {
		const value = accepted(mcpRuntimeStateSnapshotSchema, {
			phase: "offline",
			lastTransitionAt: "2026-01-01T00:00:00.000Z",
		});

		expect(Object.keys(value)).toEqual(["phase", "lastTransitionAt"]);
	});

	it("accepts every published phase, protocol era, and state error code", () => {
		for (const phase of MCP_RUNTIME_PHASES) {
			expect(accepted(mcpRuntimeStateSnapshotSchema, { ...STATE, phase })).toMatchObject({ phase });
		}
		for (const protocolEra of MCP_RUNTIME_PROTOCOL_ERAS) {
			expect(accepted(mcpRuntimeStateSnapshotSchema, { ...STATE, protocolEra })).toMatchObject({
				protocolEra,
			});
		}
		expect(
			accepted(mcpRuntimeStateSnapshotSchema, { ...STATE, errorCode: "MCP_CONNECTION_LOST" }),
		).toMatchObject({ errorCode: "MCP_CONNECTION_LOST" });
	});

	it("rejects a phase that is not a published lifecycle member", () => {
		expect(rejected(mcpRuntimeStateSnapshotSchema, { ...STATE, phase: "probing" })).toEqual([
			{ message: `Expected one of ${MCP_RUNTIME_PHASES.join(", ")}.`, path: ["phase"] },
		]);
	});

	it("rejects a protocol era and an error code outside the published unions", () => {
		expect(rejected(mcpRuntimeStateSnapshotSchema, { ...STATE, protocolEra: "ancient" })).toEqual([
			{
				message: `Expected one of ${MCP_RUNTIME_PROTOCOL_ERAS.join(", ")}.`,
				path: ["protocolEra"],
			},
		]);
		expect(rejected(mcpRuntimeStateSnapshotSchema, { ...STATE, errorCode: "MCP_TEAPOT" })).toEqual([
			{ message: "Expected a known MCP runtime state error code.", path: ["errorCode"] },
		]);
	});

	it("rejects a missing and a malformed transition timestamp", () => {
		expect(rejected(mcpRuntimeStateSnapshotSchema, { phase: "offline" })).toEqual([
			{ message: "Expected a required value.", path: ["lastTransitionAt"] },
		]);
		expect(
			rejected(mcpRuntimeStateSnapshotSchema, { ...STATE, lastTransitionAt: "yesterday" }),
		).toEqual([{ message: "Expected an ISO 8601 date-time string.", path: ["lastTransitionAt"] }]);
		expect(
			rejected(mcpRuntimeStateSnapshotSchema, {
				...STATE,
				lastTransitionAt: "2026-13-45T99:99:99Z",
			}),
		).toEqual([{ message: "Expected an ISO 8601 date-time string.", path: ["lastTransitionAt"] }]);
	});

	it("rejects an unrecognized property without echoing its value", () => {
		const issues = rejected(mcpRuntimeStateSnapshotSchema, {
			...STATE,
			generationKey: "secret-generation-key",
		});

		expect(issues).toEqual([{ message: "Unrecognized property.", path: ["generationKey"] }]);
		expect(JSON.stringify(issues)).not.toContain("secret-generation-key");
	});

	it("rejects values that are not plain snapshot objects", () => {
		for (const value of [null, undefined, [], "online", 7]) {
			expect(rejected(mcpRuntimeStateSnapshotSchema, value)).toEqual([
				{ message: "Expected an object.", path: [] },
			]);
		}
	});
});

describe("mcpRuntimeProbeSnapshotSchema", () => {
	it("accepts a complete probe and freezes its nested runtime projection", () => {
		const value = accepted(mcpRuntimeProbeSnapshotSchema, structuredClone(PROBE));

		expect(value).toEqual(PROBE);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.runtime)).toBe(true);
	});

	it("rejects an unreachable observation and a missing runtime projection", () => {
		expect(rejected(mcpRuntimeProbeSnapshotSchema, { ...PROBE, reachable: false })).toEqual([
			{ message: "Expected the literal value true.", path: ["reachable"] },
		]);
		expect(
			rejected(mcpRuntimeProbeSnapshotSchema, { reachable: true, observedAt: PROBE.observedAt }),
		).toEqual([{ message: "Expected a required value.", path: ["runtime"] }]);
	});

	it("reports nested runtime issues under the nested path", () => {
		expect(
			rejected(mcpRuntimeProbeSnapshotSchema, {
				...PROBE,
				runtime: { ...STATE, phase: "probing" },
			}),
		).toEqual([
			{ message: `Expected one of ${MCP_RUNTIME_PHASES.join(", ")}.`, path: ["runtime", "phase"] },
		]);
	});
});

describe("mcpRuntimeCapabilitiesSnapshotSchema", () => {
	it("accepts a complete capability projection", () => {
		const value = accepted(mcpRuntimeCapabilitiesSnapshotSchema, structuredClone(CAPABILITIES));

		expect(value).toEqual(CAPABILITIES);
		expect(Object.isFrozen(value)).toBe(true);
	});

	it("rejects a missing, a non-boolean, and an unrecognized capability", () => {
		expect(
			rejected(mcpRuntimeCapabilitiesSnapshotSchema, {
				resources: true,
				prompts: false,
				completion: false,
				subscriptions: true,
			}),
		).toEqual([{ message: "Expected a boolean.", path: ["tools"] }]);
		expect(
			rejected(mcpRuntimeCapabilitiesSnapshotSchema, { ...CAPABILITIES, tools: "yes" }),
		).toEqual([{ message: "Expected a boolean.", path: ["tools"] }]);
		expect(
			rejected(mcpRuntimeCapabilitiesSnapshotSchema, { ...CAPABILITIES, sampling: true }),
		).toEqual([{ message: "Unrecognized property.", path: ["sampling"] }]);
	});
});

function accepted<Snapshot>(schema: McpRuntimeSnapshotSchema<Snapshot>, value: unknown): Snapshot {
	const result = schema["~standard"].validate(value);
	if (result.issues !== undefined) {
		throw new Error(`The snapshot was unexpectedly rejected: ${JSON.stringify(result.issues)}`);
	}
	return result.value;
}

function rejected<Snapshot>(
	schema: McpRuntimeSnapshotSchema<Snapshot>,
	value: unknown,
): readonly StandardSchemaV1.Issue[] {
	const result = schema["~standard"].validate(value);
	if (result.issues === undefined) throw new Error("The snapshot was unexpectedly accepted.");
	return result.issues;
}
