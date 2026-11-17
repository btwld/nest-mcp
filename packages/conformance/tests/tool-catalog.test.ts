import { describe, expect, it, vi } from "vitest";
import {
	captureMcpToolDefinition,
	digestMcpToolSchemas,
	fingerprintMcpConformanceValue,
	MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
	selectMcpCatalogTool,
	selectMcpCatalogTools,
} from "../src/index.ts";

const search = {
	name: "search",
	inputSchema: { type: "object", properties: { q: { type: "string" } } },
	outputSchema: { type: "object" },
};

describe("exact catalog preparation", () => {
	it("captures detached frozen definitions including protocol extensions", () => {
		const input = { ...search, annotations: { readOnlyHint: true }, _meta: { extension: [1] } };
		const snapshot = captureMcpToolDefinition(input);
		input["_meta"].extension.push(2);
		expect(snapshot["_meta"].extension).toEqual([1]);
		expect(Object.isFrozen(snapshot.inputSchema.properties)).toBe(true);
		expect(Object.isFrozen(snapshot["_meta"].extension)).toBe(true);
	});

	it("rejects ambiguous identity before task or other usage filtering", () => {
		const catalog = {
			tools: [
				search,
				{ ...search, execution: { taskSupport: "required" } },
				{ ...search, name: "read" },
			],
		};
		expect(selectMcpCatalogTools(catalog)).toMatchObject({
			ambiguousNames: ["search"],
			tools: [{ name: "read" }],
		});
		expect(selectMcpCatalogTool(catalog, "search")).toEqual({ status: "ambiguous" });
		expect(selectMcpCatalogTool(catalog, "missing")).toEqual({ status: "missing" });
		expect(selectMcpCatalogTool(catalog, "read")).toMatchObject({
			status: "selected",
			tool: { name: "read" },
		});
	});

	it("bounds names, complete collections, and individual definitions", () => {
		expect(
			selectMcpCatalogTools({
				tools: [search, { ...search, name: "" }, { ...search, name: "x".repeat(257) }],
			}).tools,
		).toHaveLength(1);
		expect(() => selectMcpCatalogTools({ tools: [search] }, { maxNameLength: 0 })).toThrow(
			RangeError,
		);
		const limits = { ...MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS, maxBytes: 10 };
		expect(() => selectMcpCatalogTools({ tools: [search] }, { limits })).toThrow();
		expect(() =>
			selectMcpCatalogTools({ tools: [search] }, { definitionLimits: limits }),
		).toThrow();
	});

	it("does not execute accessor or proxy inputs", () => {
		const getter = vi.fn(() => [search]);
		const catalog = {
			get tools() {
				return getter();
			},
		};
		expect(() => selectMcpCatalogTools(catalog as { tools: (typeof search)[] })).toThrow();
		expect(getter).not.toHaveBeenCalled();
		const trap = vi.fn();
		expect(() => captureMcpToolDefinition(new Proxy(search, { get: trap }))).toThrow();
		expect(trap).not.toHaveBeenCalled();
	});

	it("hashes both exact schemas, independently of ordering and display metadata", () => {
		const read = { name: "read", inputSchema: { type: "object" } };
		const options = { domain: "test/tool-schemas/v1" };
		const digest = digestMcpToolSchemas([search, read], options);
		expect(digest).toBe(digestMcpToolSchemas([read, search], options));
		expect(digest).toBe(
			digestMcpToolSchemas([{ ...search, description: "changed" }, read], options),
		);
		expect(digest).not.toBe(
			digestMcpToolSchemas(
				[{ ...search, outputSchema: { type: "object", required: ["answer"] } }, read],
				options,
			),
		);
		expect(digest).not.toBe(
			digestMcpToolSchemas([search, read], { domain: "test/another-domain" }),
		);
		expect(digest).toBe(
			fingerprintMcpConformanceValue(
				{
					schemas: [
						{ name: "read", inputSchema: read.inputSchema, outputSchema: null },
						{ name: "search", inputSchema: search.inputSchema, outputSchema: search.outputSchema },
					],
					version: 2,
				},
				options.domain,
			),
		);
		expect(() => digestMcpToolSchemas([search, search], options)).toThrow(/unique/u);
	});
});
