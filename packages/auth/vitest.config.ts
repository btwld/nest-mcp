import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@nest-mcp\/server\/auth$/,
				replacement: new URL("../server/src/auth/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server\/security$/,
				replacement: new URL("../server/src/security/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server$/,
				replacement: new URL("../server/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/core$/,
				replacement: new URL("../core/src/index.ts", import.meta.url).pathname,
			},
		],
	},
	test: {
		include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
	},
});
