import {
	defineMcpConformancePlan,
	parseMcpConformanceReport,
	parseMcpConformanceReportJson,
	runMcpConformancePlan,
	serializeMcpConformanceReport,
	type McpConformanceCheckOutcome,
	type McpConformanceReport,
} from "../src/index.ts";
import { describe, expect, it, vi } from "vitest";

describe("conformance report JSON", () => {
	it("validates reports without Node globals and counts Unicode as UTF-8 bytes", async () => {
		const input = await report("browser", [
			{ status: "pass", code: "ONE_OK", facts: { label: "工具🔎" } },
		]);
		const json = JSON.stringify(input);
		const bytes = new TextEncoder().encode(json).byteLength;
		vi.stubGlobal("Buffer", undefined);
		try {
			expect(parseMcpConformanceReportJson(json, { maximumBytes: bytes })).toEqual(input);
			expect(serializeMcpConformanceReport(input, { maximumBytes: bytes })).toBe(json);
			expect(() => parseMcpConformanceReportJson(json, { maximumBytes: bytes - 1 })).toThrow(
				/byte safety limit/u,
			);
			expect(() =>
				parseMcpConformanceReport({ ...input, counts: { ...input.counts, pass: 2 } }),
			).toThrow(/inconsistent/u);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("round-trips immutable JSON and rejects oversized input", async () => {
		const original = await report("json", [{ status: "pass", code: "ONE_OK" }]);
		const parsed = parseMcpConformanceReportJson(serializeMcpConformanceReport(original));
		expect(parsed).toEqual(original);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(() => parseMcpConformanceReportJson(`"${"x".repeat(1_048_577)}"`)).toThrow(
			/byte safety limit/u,
		);
	});

	it("enforces default report bytes while allowing a bounded explicit override", async () => {
		const facts = Object.fromEntries(
			Array.from({ length: 32 }, (_, index) => [`fact.${String(index)}`, "x".repeat(1_024)]),
		);
		const outcomes = Array.from(
			{ length: 64 },
			() => ({ status: "pass", code: "CHECK_OK", facts }) as const,
		);
		const large = await runMcpConformancePlan(
			defineMcpConformancePlan({
				id: "large",
				version: "1",
				title: "Large bounded report",
				checks: outcomes.map((_, index) => ({
					id: `check.${String(index)}`,
					title: `Check ${String(index)}`,
					risk: "read-only" as const,
					run: ({ target }: { readonly target: typeof outcomes }) => target[index]!,
				})),
			}),
			{
				target: outcomes,
				runId: "large-report",
				descriptor: {
					target: { kind: "fixture", id: "large" },
					subject: { name: "@nest-mcp/nestjs", version: "test" },
				},
				limits: {
					maxFactStringLength: 1_024,
					maxJsonBytes: 4_194_304,
				},
			},
		);
		expect(() => serializeMcpConformanceReport(large)).toThrow(/1048576 byte/u);
		const serialized = serializeMcpConformanceReport(large, { maximumBytes: 4_194_304 });
		expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(1_048_576);
		expect(parseMcpConformanceReportJson(serialized, { maximumBytes: 4_194_304 })).toEqual(large);

		const oversizedFacts = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [`fact.${String(index)}`, "x".repeat(1_024)]),
		);
		expect(() =>
			parseMcpConformanceReport(
				{
					...large,
					checks: large.checks.map((check) => ({ ...check, facts: oversizedFacts })),
				},
				{ maximumBytes: 4_194_304 },
			),
		).toThrow(/hard JSON byte/u);
	});

	it("rejects duplicate identities, inconsistent time, and unsafe counters", async () => {
		const generated = await report("validated", [{ status: "pass", code: "ONE_OK" }]);
		const firstPlanCheck = generated.plan.checks[0]!;
		const firstReportCheck = generated.checks[0]!;
		expect(() =>
			parseMcpConformanceReport({
				...generated,
				plan: { ...generated.plan, checks: [firstPlanCheck, firstPlanCheck] },
				counts: { ...generated.counts, pass: 2 },
				checks: [firstReportCheck, firstReportCheck],
			}),
		).toThrow(/unique/u);
		expect(() =>
			parseMcpConformanceReport({
				...generated,
				finishedAt: "2025-01-01T00:00:00.000Z",
			}),
		).toThrow(/finish before/u);
		expect(() =>
			parseMcpConformanceReport({
				...generated,
				durationMs: Number.MAX_SAFE_INTEGER + 1,
			}),
		).toThrow();
	});
});

async function report(
	runId: string,
	outcomes: readonly McpConformanceCheckOutcome[],
): Promise<McpConformanceReport> {
	const plan = defineMcpConformancePlan({
		id: "report",
		version: "1",
		title: "Report",
		checks: outcomes.map((_, index) => ({
			id: `check.${String(index + 1)}`,
			title: `Check ${String(index + 1)}`,
			risk: "read-only" as const,
			run: ({ target }: { readonly target: readonly McpConformanceCheckOutcome[] }) =>
				target[index]!,
		})),
	});
	return runMcpConformancePlan(plan, {
		target: outcomes,
		runId,
		descriptor: {
			target: { kind: "connection", id: "fixture-a", revision: 1, generation: 1 },
			subject: { name: "@nest-mcp/nestjs", version: runId },
		},
	});
}
