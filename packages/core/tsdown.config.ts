import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/authorization.ts",
		"src/lifecycle.ts",
		"src/middleware.ts",
		"src/operation.ts",
	],
	format: ["esm"],
	platform: "neutral",
	target: "es2023",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
});
