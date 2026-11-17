import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@nest-mcp/core": new URL("../core/src/index.ts", import.meta.url).pathname,
			"@nest-mcp/server": new URL("../server/src/index.ts", import.meta.url).pathname,
		},
	},
	test: {
		include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
