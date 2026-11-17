import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "mcp-report-consumer-"));
try {
	execFileSync(
		"pnpm",
		["--filter", "@nest-mcp/conformance", "pack", "--pack-destination", directory],
		{ stdio: "inherit" },
	);
	const { version } = JSON.parse(
		await (
			await import("node:fs/promises")
		).readFile(new URL("../packages/conformance/package.json", import.meta.url), "utf8"),
	);
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: { "@nest-mcp/conformance": `file:./nest-mcp-conformance-${version}.tgz` },
		}),
	);
	execFileSync("pnpm", ["install", "--ignore-workspace", "--ignore-scripts"], {
		cwd: directory,
		stdio: "inherit",
	});
	await writeFile(
		join(directory, "consumer.mjs"),
		`
    import assert from "node:assert/strict";
    import { McpConformanceReportSchema, parseMcpConformanceReportJson, serializeMcpConformanceReport } from "@nest-mcp/conformance/report";
    globalThis.Buffer = undefined;
    const check = { id: "discovery", title: "Tools", risk: "read-only" };
    const report = McpConformanceReportSchema.parse({
      reportSchemaVersion: 1, fingerprintVersion: 1, runId: "sample",
      plan: { id: "sample", version: "1", title: "Inspection", digest: "sha256:" + "a".repeat(43), checks: [check] },
      descriptor: { target: { kind: "server", id: "sample" }, subject: { name: "consumer", version: "1" } },
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", durationMs: 1,
      completion: "completed", verdict: "pass", counts: { pass: 1, warn: 0, fail: 0, skip: 0, error: 0 },
      checks: [{ ...check, status: "pass", code: "OK", durationMs: 1, facts: { label: "工具" }, factsOmittedCount: 0 }]
    });
    assert.deepEqual(parseMcpConformanceReportJson(serializeMcpConformanceReport(report)), report);
    assert.equal(McpConformanceReportSchema.safeParse({ ...report, verdict: "fail" }).success, false);
  `,
	);
	execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, stdio: "inherit" });
	console.log("Packed report consumer validates reports without Node globals.");
} finally {
	await rm(directory, { recursive: true, force: true });
}
