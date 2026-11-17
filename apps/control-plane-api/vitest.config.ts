import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@nest-mcp\/auth\/cimd$/,
				replacement: new URL("../../packages/auth/src/cimd/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/auth\/stores$/,
				replacement: new URL("../../packages/auth/src/stores/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/auth$/,
				replacement: new URL("../../packages/auth/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/conformance$/,
				replacement: new URL("../../packages/conformance/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/client\/oauth$/,
				replacement: new URL("../../packages/client/src/oauth/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/gateway$/,
				replacement: new URL("../../packages/gateway/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/core$/,
				replacement: new URL("../../packages/core/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server\/auth$/,
				replacement: new URL("../../packages/server/src/auth/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/server\/testing$/,
				replacement: new URL("../../packages/server/src/testing/index.ts", import.meta.url)
					.pathname,
			},
			{
				find: /^@nest-mcp\/server\/security$/,
				replacement: new URL("../../packages/server/src/security/index.ts", import.meta.url)
					.pathname,
			},
			{
				find: /^@nest-mcp\/server$/,
				replacement: new URL("../../packages/server/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/client$/,
				replacement: new URL("../../packages/client/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/manager$/,
				replacement: new URL("../../packages/manager/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/observability$/,
				replacement: new URL("../../packages/observability/src/index.ts", import.meta.url).pathname,
			},
			{
				find: /^@nest-mcp\/nestjs\/manager$/,
				replacement: new URL("../../packages/nestjs/src/manager/index.ts", import.meta.url)
					.pathname,
			},
			{
				find: /^@nest-mcp\/nestjs$/,
				replacement: new URL("../../packages/nestjs/src/index.ts", import.meta.url).pathname,
			},
		],
	},
	test: {
		include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
		testTimeout: 15_000,
	},
});
