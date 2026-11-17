import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@nest-mcp\/core$/,
				replacement: new URL("../core/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/client$/,
				replacement: new URL("../client/src/index.ts", import.meta.url).pathname,
			},
		],
	},
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
