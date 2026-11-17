import "reflect-metadata";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApplication } from "./bootstrap.ts";
import { ControlPlaneConfigService } from "./config/control-plane-config.service.ts";

export async function main(): Promise<void> {
	const app = await createApplication();
	const config = app.get(ControlPlaneConfigService);
	await app.listen(config.port, config.host);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
	await main();
}
