import {
	canonicalizeMcpConformanceValue,
	defineMcpConformancePlan,
	digestMcpConformancePlan,
	fingerprintMcpConformanceValue,
	runMcpConformancePlan,
	type McpConformanceCheckOutcome,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

describe("conformance plans and fingerprints", () => {
	it("normalizes object keys while conservatively preserving array order", () => {
		expect(fingerprintMcpConformanceValue({ b: 2, a: [1, 2] })).toBe(
			fingerprintMcpConformanceValue({ a: [1, 2], b: 2 }),
		);
		expect(fingerprintMcpConformanceValue({ a: [1, 2] })).not.toBe(
			fingerprintMcpConformanceValue({ a: [2, 1] }),
		);
	});

	it("canonicalizes sparse array entries as null without colliding with an empty array", () => {
		const sparse: unknown[] = [];
		sparse.length = 1;
		expect(fingerprintMcpConformanceValue(sparse)).not.toBe(fingerprintMcpConformanceValue([]));
		expect(fingerprintMcpConformanceValue(sparse)).toBe(fingerprintMcpConformanceValue([null]));
	});

	it("rejects cycles and non-finite values", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => fingerprintMcpConformanceValue(cyclic)).toThrow(/cycles/u);
		expect(() => fingerprintMcpConformanceValue({ invalid: Number.NaN })).toThrow(/finite/u);
	});

	it("rejects oversized strings before building an unbounded canonical value", () => {
		expect(() => fingerprintMcpConformanceValue("x".repeat(8_388_609))).toThrow(/8 MiB/u);
		expect(() => fingerprintMcpConformanceValue("\0".repeat(1_398_102))).toThrow(/8 MiB/u);
	});

	it("matches well-formed JSON string escaping without materializing one unbounded chunk", () => {
		const hostile = '"\\\b\t\n\f\r\0\u001f\u2028😀\ud800x\udc00';
		expect(canonicalizeMcpConformanceValue(hostile)).toBe(JSON.stringify(hostile));
	});

	it("rejects structurally oversized inputs before deep recursion", () => {
		const sparse: unknown[] = [];
		sparse.length = 100_001;
		expect(() => fingerprintMcpConformanceValue(sparse)).toThrow(/structural safety/u);

		let nested: unknown = null;
		for (let depth = 0; depth < 130; depth += 1) nested = { nested };
		expect(() => fingerprintMcpConformanceValue(nested)).toThrow(/structural safety/u);
	});

	it("snapshots an immutable plan and includes static policy in its digest", () => {
		const plan = defineMcpConformancePlan({
			id: "safe.discovery",
			version: "1",
			title: "Safe discovery",
			checks: [
				{
					id: "protocol.ping",
					title: "Ping",
					risk: "read-only",
					run: () => ({ status: "pass", code: "PING_OK" }),
				},
			],
		});
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.checks)).toBe(true);
		expect(digestMcpConformancePlan(plan)).toMatch(/^sha256:/u);

		const sideEffecting = defineMcpConformancePlan({
			...plan,
			checks: [{ ...plan.checks[0]!, risk: "side-effecting" }],
		});
		expect(digestMcpConformancePlan(sideEffecting)).not.toBe(digestMcpConformancePlan(plan));
	});

	it("captures check execution when the plan is defined", async () => {
		const source: {
			id: string;
			title: string;
			risk: "read-only";
			run: () => McpConformanceCheckOutcome;
		} = {
			id: "captured",
			title: "Captured",
			risk: "read-only",
			run: () => ({ status: "pass", code: "ORIGINAL" }),
		};
		const plan = defineMcpConformancePlan({
			id: "snapshot",
			version: "1",
			title: "Snapshot",
			checks: [source],
		});
		const digest = digestMcpConformancePlan(plan);
		source.run = () => ({ status: "fail", code: "MUTATED" });

		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "captured-run",
			descriptor: {
				target: { kind: "connection", id: "fixture" },
				subject: { name: "@nest-mcp/nestjs", version: "test" },
			},
		});

		expect(report.checks[0]).toMatchObject({ status: "pass", code: "ORIGINAL" });
		expect(digestMcpConformancePlan(plan)).toBe(digest);
	});

	it("rejects duplicate check identities", () => {
		expect(() =>
			defineMcpConformancePlan({
				id: "duplicate",
				version: "1",
				title: "Duplicate",
				checks: [
					{
						id: "same",
						title: "First",
						risk: "read-only",
						run: () => ({ status: "pass", code: "OK" }),
					},
					{
						id: "same",
						title: "Second",
						risk: "read-only",
						run: () => ({ status: "pass", code: "OK" }),
					},
				],
			}),
		).toThrow(/Duplicate/u);
	});
});
