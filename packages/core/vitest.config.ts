import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			exclude: ["**/*.config.ts", "**/index.ts"],
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
		environment: "node",
		include: ["tests/**/*.test.ts"],
		clearMocks: true,
		restoreMocks: true,
	},
});
