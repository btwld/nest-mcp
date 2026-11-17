import { describe, expect, it, vi } from "vitest";
import {
	createMcpPassiveDiscoveryPlan,
	runMcpConformancePlan,
	type McpConformanceCatalogSnapshot,
	type McpPassiveDiscoveryTarget,
} from "../src/index.ts";

const options = { catalogDomain: "test/catalog/v1", toolSchemaDomain: "test/schema/v1" };
const tool = { name: "search", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
const catalog: McpConformanceCatalogSnapshot = {
	tools: [tool],
	resources: [],
	resourceTemplates: [],
	prompts: [],
};

function target(snapshot = catalog) {
	return {
		snapshot: () => ({
			state: "connected",
			protocolEra: "modern",
			negotiatedProtocolVersion: "2026-07-28",
		}),
		ping: vi.fn(async () => {}),
		catalog: vi.fn(async () => snapshot),
		schemaCompiles: vi.fn(() => true),
	} satisfies McpPassiveDiscoveryTarget;
}
function run(subject: McpPassiveDiscoveryTarget) {
	return runMcpConformancePlan(createMcpPassiveDiscoveryPlan(options), {
		target: subject,
		runId: "inspection",
		descriptor: {
			target: { kind: "connection", id: "test" },
			subject: { name: "test", version: "1" },
		},
	});
}

describe("passive discovery plan", () => {
	it("executes the seven read-only checks on a host-owned target", async () => {
		const subject = target();
		const report = await run(subject);
		expect(report.verdict).toBe("pass");
		expect(report.checks.map(({ id }) => id)).toEqual([
			"connection.connected",
			"protocol.negotiated",
			"protocol.ping",
			"catalog.discovery",
			"catalog.identities",
			"tools.schemas",
			"catalog.digest",
		]);
		expect(subject.ping).toHaveBeenCalledOnce();
		expect(subject.schemaCompiles).toHaveBeenCalledTimes(2);
		expect(
			createMcpPassiveDiscoveryPlan(options).checks.every(({ risk }) => risk === "read-only"),
		).toBe(true);
	});
	it("reports duplicate identities and invalid input/output schemas separately", async () => {
		const subject = target({ ...catalog, tools: [tool, tool] });
		subject.schemaCompiles.mockReturnValue(false);
		const report = await run(subject);
		expect(report.checks.find(({ id }) => id === "catalog.identities")).toMatchObject({
			status: "fail",
			code: "CATALOG_IDENTITIES_DUPLICATED",
			facts: { duplicateCount: 1 },
		});
		expect(report.checks.find(({ id }) => id === "tools.schemas")).toMatchObject({
			status: "fail",
			facts: { invalidInputSchemas: 2, invalidOutputSchemas: 2 },
		});
	});
	it("stops schema compilation at its fixed budget", async () => {
		const subject = target({
			...catalog,
			tools: Array.from({ length: 129 }, (_, index) => ({ ...tool, name: `tool${String(index)}` })),
		});
		const report = await run(subject);
		expect(subject.schemaCompiles).toHaveBeenCalledTimes(256);
		expect(report.checks.find(({ id }) => id === "tools.schemas")).toMatchObject({
			code: "TOOL_SCHEMA_BUDGET_EXCEEDED",
			status: "error",
		});
	});
	it("validates fingerprint domains at construction", () => {
		expect(() => createMcpPassiveDiscoveryPlan({ ...options, catalogDomain: "INVALID" })).toThrow(
			TypeError,
		);
	});
});
