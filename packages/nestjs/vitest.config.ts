import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@nest-mcp\/manager$/,
				replacement: new URL("../manager/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server\/auth$/,
				replacement: new URL("../server/src/auth/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server\/security$/,
				replacement: new URL("../server/src/security/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server\/testing$/,
				replacement: new URL("../server/src/testing/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/auth\/testing$/,
				replacement: new URL("../auth/src/testing/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/auth\/cimd$/,
				replacement: new URL("../auth/src/cimd/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/auth\/stores$/,
				replacement: new URL("../auth/src/stores/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/auth$/,
				replacement: new URL("../auth/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/client$/,
				replacement: new URL("../client/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/core$/,
				replacement: new URL("../core/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/gateway$/,
				replacement: new URL("../gateway/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/observability$/,
				replacement: new URL("../observability/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server$/,
				replacement: new URL("../server/src/index.ts", import.meta.url).pathname,
			},
		],
	},
	test: {
		include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
	},
});
