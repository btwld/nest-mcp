import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packagesRoot = join(repositoryRoot, "packages");
const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(packagesRoot, entry.name));

const violations = [];

for (const packageDirectory of packageDirectories) {
	const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
	const runtimeDependencies = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);
	const outputFiles = await findModuleFiles(join(packageDirectory, "dist"));

	for (const outputFile of outputFiles) {
		const source = await readFile(outputFile, "utf8");

		for (const specifier of moduleSpecifiers(source)) {
			if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) continue;

			const dependencyName = packageNameOf(specifier);
			if (dependencyName === manifest.name || runtimeDependencies.has(dependencyName)) continue;

			violations.push(
				`${manifest.name}: ${specifier} is imported by ${outputFile.slice(repositoryRoot.length + 1)} but ${dependencyName} is not a dependency or peer dependency`,
			);
		}
	}
}

if (violations.length > 0) {
	throw new Error(`Built package dependency validation failed:\n- ${violations.join("\n- ")}`);
}

process.stdout.write(
	`Validated built runtime dependencies for ${packageDirectories.length} packages.\n`,
);

async function findModuleFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await findModuleFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
	}

	return files;
}

function moduleSpecifiers(source) {
	const specifiers = new Set();
	const staticPattern = /\b(?:import|export)\s*(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']/gu;
	const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']/gu;

	for (const pattern of [staticPattern, dynamicPattern]) {
		for (const match of source.matchAll(pattern)) {
			const [, specifier] = match;
			if (specifier !== undefined) specifiers.add(specifier);
		}
	}

	return specifiers;
}

function packageNameOf(specifier) {
	if (!specifier.startsWith("@")) return specifier.split("/", 1)[0];
	const [scope, name] = specifier.split("/", 3);
	if (scope === undefined || name === undefined) {
		throw new TypeError(`Invalid scoped package specifier: ${specifier}`);
	}
	return `${scope}/${name}`;
}
