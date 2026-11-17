import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const MCP_CONFORMANCE_SUBJECT = Object.freeze({
	name: "@nest-mcp/nestjs",
	version: readMcpPackageVersion(),
});

function readMcpPackageVersion(): string {
	const manifest: unknown = require("@nest-mcp/nestjs/package.json");
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("version" in manifest) ||
		typeof manifest.version !== "string" ||
		manifest.version.length === 0
	) {
		throw new TypeError("@nest-mcp/nestjs/package.json does not declare a package version.");
	}
	return manifest.version;
}
