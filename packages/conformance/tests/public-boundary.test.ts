import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	MCP_CONFORMANCE_CAPTURE_REJECTED,
	MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
	McpConformanceCaptureError,
	captureMcpToolArguments,
	projectMcpToolResult,
	type McpConformanceCaptureOptions,
	type McpConformanceUndefinedPolicy,
} from "../src/index.ts";

const REJECT_UNDEFINED: McpConformanceUndefinedPolicy = "reject";
const REJECT_UNDEFINED_OPTIONS = {
	undefinedPolicy: REJECT_UNDEFINED,
} satisfies McpConformanceCaptureOptions;

describe("@nest-mcp/conformance public boundary", () => {
	it("keeps the kernel free of Nest, manager, client, SDK, and product imports", async () => {
		const files = [
			"capture.ts",
			"catalog.ts",
			"errors.ts",
			"facts.ts",
			"fingerprint.ts",
			"index.ts",
			"limits.ts",
			"plan.ts",
			"passive-discovery.ts",
			"tool-catalog.ts",
			"report.ts",
			"runner.ts",
			"tool-result.ts",
			"types.ts",
		];
		const sources = await Promise.all(
			files.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")),
		);
		const joined = sources.join("\n");
		expect(joined).not.toMatch(/@nestjs\//u);
		expect(joined).not.toMatch(/@nest-mcp\/(?:client|core|manager|gateway)/u);
		expect(joined).not.toMatch(/@modelcontextprotocol\//u);
		expect(joined).not.toMatch(/apps\/control-plane/u);
	});

	it("exports the capture undefined policy through the package entrypoint", () => {
		expect(() =>
			captureMcpToolArguments(
				{ nested: [undefined] },
				MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
				REJECT_UNDEFINED_OPTIONS,
			),
		).toThrowError(
			expect.objectContaining({
				code: MCP_CONFORMANCE_CAPTURE_REJECTED,
				name: McpConformanceCaptureError.name,
			}),
		);
	});

	it("exports the bounded tool-result projection through the package entrypoint", () => {
		expect(projectMcpToolResult({ content: [{ type: "text", text: "ok" }] })).toEqual({
			content: [{ kind: "text", text: "ok", truncated: false }],
			isError: false,
			truncated: false,
		});
	});
});
