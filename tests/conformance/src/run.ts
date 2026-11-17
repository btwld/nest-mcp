import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startEverythingServer } from "./http-fixture.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const conformanceCli = join(
	dirname(createRequire(import.meta.url).resolve("@modelcontextprotocol/conformance/package.json")),
	"dist",
	"index.js",
);

/**
 * One pass of the official suite, each with its own baseline.
 *
 * `modern` runs exactly the scenarios the 2026-07-28 revision requires, frozen
 * at its release. `legacy` keeps the stateless 2025-era compatibility path
 * honest. A forwarded `--scenario` narrows a pass, and `--requirements`
 * replaces scenario selection, so a narrowed modern pass filters by spec
 * version instead.
 */
const PROFILES = {
	modern: {
		selection: ["--requirements", "2026-07-28"],
		narrowed: ["--spec-version", "2026-07-28"],
	},
	legacy: {
		selection: ["--spec-version", "2025-11-25"],
		narrowed: ["--spec-version", "2025-11-25"],
	},
} as const;

type Profile = keyof typeof PROFILES;

const PROFILE_NAMES: readonly Profile[] = ["modern", "legacy"];

function isProfile(value: string | undefined): value is Profile {
	return value === "modern" || value === "legacy";
}

/**
 * Starts the fixture on an ephemeral port, then shells out to the official
 * conformance CLI in server mode and reports whether the pass met its baseline.
 */
async function runProfile(profile: Profile, extra: readonly string[]): Promise<boolean> {
	const fixture = await startEverythingServer();
	process.stdout.write(`\n[${profile}] Conformance fixture listening on ${fixture.url}\n`);
	const { selection, narrowed } = PROFILES[profile];
	const child = spawn(
		process.execPath,
		[
			conformanceCli,
			"server",
			"--url",
			fixture.url,
			"--expected-failures",
			join(packageRoot, `expected-failures.${profile}.yaml`),
			...(extra.includes("--scenario") ? narrowed : selection),
			...extra,
		],
		{ cwd: packageRoot, stdio: "inherit" },
	);

	try {
		await once(child, "close");
		// A signalled exit reports no code; treat it as a failure rather than a pass.
		return child.signalCode === null && child.exitCode === 0;
	} finally {
		await fixture.close();
	}
}

/**
 * The first argument may name one profile; without it both run. Remaining
 * arguments are forwarded, so
 * `pnpm run conformance -- modern --scenario caching --verbose` narrows a run.
 * pnpm forwards its own `--` separator, which Commander would reject as a
 * positional argument, so it is dropped here.
 */
const forwarded = process.argv.slice(2).filter((argument) => argument !== "--");
const [first, ...rest] = forwarded;
const requested = isProfile(first) ? [first] : PROFILE_NAMES;
const extra = isProfile(first) ? rest : forwarded;

const failed: Profile[] = [];
for (const profile of requested) {
	// Sequential by design: each pass owns its fixture and writes straight to stdout.
	// oxlint-disable-next-line no-await-in-loop
	if (!(await runProfile(profile, extra))) failed.push(profile);
}

if (failed.length > 0) {
	process.stderr.write(`\nConformance baseline not met for: ${failed.join(", ")}\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
