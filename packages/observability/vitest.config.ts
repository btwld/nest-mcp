import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@nest-mcp/core": new URL("../core/src/index.ts", import.meta.url).pathname,
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
