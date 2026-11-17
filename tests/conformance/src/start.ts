import { startEverythingServer } from "./http-fixture.ts";

/**
 * Serves the everything-server fixture until the process is signalled.
 *
 * `PORT` pins a fixed port for manual probing; omitting it binds an ephemeral
 * one, which is what CI uses. The resolved endpoint is written to stdout so a
 * shell can capture it.
 */
const port = Number.parseInt(process.env.PORT ?? "0", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
	process.stderr.write(
		`PORT must be an integer between 0 and 65535, received ${String(process.env.PORT)}.\n`,
	);
	process.exit(1);
}

const fixture = await startEverythingServer(port);
process.stdout.write(`${fixture.url}\n`);

let closing: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		closing ??= fixture.close();
		void closing.then(
			() => process.exit(0),
			() => process.exit(1),
		);
	});
}
