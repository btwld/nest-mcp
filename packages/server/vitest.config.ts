import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@nest-mcp/core": new URL("../core/src/index.ts", import.meta.url).pathname,
		},
	},
	test: {
		include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
	},
});
