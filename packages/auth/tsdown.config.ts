import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/cimd/index.ts", "src/stores/index.ts", "src/testing/index.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@modelcontextprotocol\//, /^@nest-mcp\//, "jose"],
	},
});
