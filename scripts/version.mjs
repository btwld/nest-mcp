import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { format, resolveConfig } from "prettier";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const changesetsManifestPath = require.resolve("@changesets/cli/package.json");
const { bin } = require(changesetsManifestPath);
const changesetsBin = join(dirname(changesetsManifestPath), bin.changeset);

const result = spawnSync(process.execPath, [changesetsBin, "version", ...process.argv.slice(2)], {
	cwd: repositoryRoot,
	stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal !== null) throw new Error(`Changesets version terminated with ${result.signal}`);
if (result.status !== 0) {
	process.exitCode = result.status ?? 1;
} else {
	const preStatePath = join(repositoryRoot, ".changeset", "pre.json");
	let source;

	try {
		source = await readFile(preStatePath, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	if (source !== undefined) {
		const config = (await resolveConfig(preStatePath)) ?? {};
		const formatted = await format(source, { ...config, filepath: preStatePath });
		if (formatted !== source) await writeFile(preStatePath, formatted);
	}
}
