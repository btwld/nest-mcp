import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/ai-sdk/index.ts",
		"src/oauth/index.ts",
		"src/oauth/dynamic-registration.ts",
	],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@modelcontextprotocol\//, /^@nest-mcp\/core(\/|$)/, /^zod(\/|$)/],
	},
});
