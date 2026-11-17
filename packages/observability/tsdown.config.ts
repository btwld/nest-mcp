import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/attributes.ts",
		"src/logging.ts",
		"src/metrics.ts",
		"src/tracing.ts",
	],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@nest-mcp\/core(\/|$)/],
	},
});
