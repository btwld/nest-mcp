import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startEverythingServer } from "./http-fixture.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedFailures = join(packageRoot, "expected-failures.yaml");
const conformanceCli = join(
	dirname(createRequire(import.meta.url).resolve("@modelcontextprotocol/conformance/package.json")),
	"dist",
	"index.js",
);

/**
 * Starts the fixture on an ephemeral port, then shells out to the official
 * conformance CLI in server mode. Extra arguments are forwarded, so
 * `pnpm run conformance -- --scenario server-initialize --verbose` narrows a run.
 * pnpm forwards its own `--` separator, which Commander would reject as a
 * positional argument, so it is dropped here.
 */
const forwarded = process.argv.slice(2).filter((argument) => argument !== "--");
const fixture = await startEverythingServer();
process.stdout.write(`Conformance fixture listening on ${fixture.url}\n`);

const child = spawn(
	process.execPath,
	[
		conformanceCli,
		"server",
		"--url",
		fixture.url,
		"--expected-failures",
		expectedFailures,
		...forwarded,
	],
	{ cwd: packageRoot, stdio: "inherit" },
);

try {
	await once(child, "close");
	// A signalled exit reports no code; treat it as a failure rather than a pass.
	process.exitCode = child.signalCode === null ? (child.exitCode ?? 1) : 1;
} finally {
	await fixture.close();
}
