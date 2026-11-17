import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	MCP_RUNTIME_LEASE_MODE_CONFLICT,
	MCP_RUNTIME_PHASES,
	MCP_RUNTIME_PROTOCOL_ERAS,
	mcpRuntimeCapabilitiesSnapshotSchema,
	mcpRuntimeProbeSnapshotSchema,
	mcpRuntimeStateSnapshotSchema,
} from "../src/index.ts";

const SOURCE_FILES = [
	"errors.ts",
	"index.ts",
	"runtime-factory.ts",
	"runtime-manager.ts",
	"runtime-ownership.ts",
	"runtime-snapshots.ts",
	"runtime-state.ts",
	"types.ts",
];

describe("@nest-mcp/manager public boundary", () => {
	it("pins the public exclusive-lease conflict code", () => {
		expect(MCP_RUNTIME_LEASE_MODE_CONFLICT).toBe("MCP_LEASE_MODE_CONFLICT");
	});

	it("keeps the neutral package free of Nest and product-application imports", async () => {
		const sources = await Promise.all(
			SOURCE_FILES.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")),
		);
		const joined = sources.join("\n");
		expect(joined).not.toMatch(/@nestjs\//);
		expect(joined).not.toMatch(/apps\/control-plane-api/);
		expect(joined).not.toMatch(/ConnectionRepository|EndpointAdmission|ControlPlaneError/);
	});

	it("keeps reversible offline intent outside cooperative ownership", async () => {
		const ownership = await readFile(
			new URL("../src/runtime-ownership.ts", import.meta.url),
			"utf8",
		);

		expect(ownership).not.toMatch(/\.setOffline\s*\(/);
	});

	it("publishes frozen runtime tuples that mirror every declared union member", async () => {
		const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

		expect([...MCP_RUNTIME_PHASES]).toEqual(declaredUnionMembers(types, "McpRuntimePhase"));
		expect([...MCP_RUNTIME_PROTOCOL_ERAS]).toEqual(["legacy", "modern"]);
		expect(Object.isFrozen(MCP_RUNTIME_PHASES)).toBe(true);
		expect(Object.isFrozen(MCP_RUNTIME_PROTOCOL_ERAS)).toBe(true);
	});

	it("publishes every snapshot validator as a synchronous Standard Schema", () => {
		for (const schema of [
			mcpRuntimeCapabilitiesSnapshotSchema,
			mcpRuntimeProbeSnapshotSchema,
			mcpRuntimeStateSnapshotSchema,
		]) {
			expect(schema["~standard"]).toMatchObject({ version: 1, vendor: "@nest-mcp/manager" });
			expect(schema["~standard"].validate({})).not.toBeInstanceOf(Promise);
			expect(Object.isFrozen(schema)).toBe(true);
		}
	});
});

function declaredUnionMembers(source: string, name: string): string[] {
	const declaration = new RegExp(`export type ${name} =([^;]*);`).exec(source)?.[1];
	if (declaration === undefined) throw new Error(`The ${name} declaration is required.`);
	return Array.from(declaration.matchAll(/"([^"]+)"/g), (match) => match[1]!);
}
