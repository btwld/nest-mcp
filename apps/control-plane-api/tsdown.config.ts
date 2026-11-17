import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/main.ts", "src/smoke.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: false,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [
			/^@modelcontextprotocol\//,
			/^@nestjs\//,
			/^@nest-mcp\//,
			"reflect-metadata",
			"rxjs",
			"zod",
		],
	},
});
