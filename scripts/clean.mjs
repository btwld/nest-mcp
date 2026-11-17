import { glob, rm } from "node:fs/promises";
import { extname } from "node:path";

for await (const path of glob([
	"packages/*/dist",
	"packages/*/dist-tsc",
	"apps/*/dist",
	"apps/*/dist-tsc",
	"apps/*/.next",
	"apps/*/.vinext",
	"apps/*/.wrangler",
	"apps/*/*.tsbuildinfo",
	"tests/conformance/dist-tsc",
	"coverage",
])) {
	await rm(path, { force: true, recursive: true });
}

// Also remove files produced when TypeScript is accidentally invoked without a
// workspace outDir. Workspace source is TypeScript-only, so a JavaScript/declaration
// sibling of an existing source file is always generated output.
for await (const sourcePath of glob([
	"packages/*/src/**/*.ts",
	"packages/*/tests/**/*.ts",
	"apps/*/src/**/*.ts",
	"apps/*/tests/**/*.ts",
	"tests/conformance/src/**/*.ts",
])) {
	if (sourcePath.endsWith(".d.ts")) continue;
	const stem = sourcePath.slice(0, -extname(sourcePath).length);
	for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
		await rm(`${stem}${suffix}`, { force: true });
	}
}
