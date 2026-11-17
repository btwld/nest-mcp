import { appendFileSync } from "node:fs";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const protocolEra = process.env["MCP_FIXTURE_ERA"] ?? "modern";
if (protocolEra !== "modern" && protocolEra !== "legacy") {
	throw new TypeError("MCP_FIXTURE_ERA must be 'modern' or 'legacy'.");
}
const SERVER_INFO = Object.freeze({
	name: `independent-${protocolEra}-stdio-fixture`,
	version: "1.0.0",
});
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const lifecycleFile = process.env["MCP_FIXTURE_LIFECYCLE_FILE"];

let input = "";
let shuttingDown = false;
let legacyInitialized = false;
let legacyReady = false;

recordLifecycle("start");
process.once("exit", (code) => recordLifecycle("exit", { code }));

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	for (;;) {
		const newline = input.indexOf("\n");
		if (newline === -1) break;
		const line = input.slice(0, newline).trim();
		input = input.slice(newline + 1);
		if (line.length > 0) handleLine(line);
	}
});
process.stdin.once("end", () => shutdown("stdin-end"));
process.stdin.once("error", (error) => fail(error));
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function handleLine(line) {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		sendError(null, -32700, "Parse error");
		return;
	}

	if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		sendError(null, -32600, "Invalid Request");
		return;
	}
	if (typeof request.id !== "string" && typeof request.id !== "number") {
		if (
			protocolEra !== "legacy" ||
			request.method !== "notifications/initialized" ||
			!legacyInitialized
		) {
			fail(new Error(`Unexpected notification: ${request.method}`));
			return;
		}
		legacyReady = true;
		recordLifecycle("notification", { method: request.method });
		return;
	}

	recordLifecycle("request", { id: request.id, method: request.method });
	if (protocolEra === "modern") {
		const envelopeError = validateEnvelope(request.params);
		if (envelopeError !== undefined) {
			sendError(request.id, -32602, envelopeError);
			return;
		}
	}

	switch (request.method) {
		case "server/discover":
			if (protocolEra === "legacy") {
				sendError(request.id, -32601, "Method not found");
				return;
			}
			sendResult(request.id, {
				resultType: "complete",
				ttlMs: 0,
				cacheScope: "private",
				supportedVersions: [MODERN_PROTOCOL_VERSION],
				capabilities: { tools: {} },
				instructions: "Independent hand-rolled stdio fixture.",
				_meta: serverMetadata(),
			});
			return;
		case "initialize":
			if (!isValidLegacyInitialize(request.params)) {
				sendError(request.id, -32602, "Invalid legacy initialize request");
				return;
			}
			legacyInitialized = true;
			sendResult(request.id, {
				protocolVersion: LEGACY_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
				instructions: "Independent hand-rolled legacy stdio fixture.",
			});
			return;
		case "tools/list":
			if (protocolEra === "legacy" && !legacyReady) {
				sendError(request.id, -32002, "Legacy session is not initialized");
				return;
			}
			sendResult(request.id, {
				...(protocolEra === "modern"
					? {
							resultType: "complete",
							ttlMs: 0,
							cacheScope: "private",
							_meta: serverMetadata(),
						}
					: {}),
				tools: [
					{
						name: "echo",
						description: "Echoes text from an independently implemented MCP server.",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
							additionalProperties: false,
						},
					},
				],
			});
			return;
		case "tools/call": {
			if (protocolEra === "legacy" && !legacyReady) {
				sendError(request.id, -32002, "Legacy session is not initialized");
				return;
			}
			const parameters = request.params;
			const argumentsValue = isRecord(parameters) ? parameters.arguments : undefined;
			const text = isRecord(argumentsValue) ? argumentsValue.text : undefined;
			if (!isRecord(parameters) || parameters.name !== "echo" || typeof text !== "string") {
				sendError(request.id, -32602, "echo requires a string 'text' argument");
				return;
			}
			sendResult(request.id, {
				...(protocolEra === "modern" ? { resultType: "complete", _meta: serverMetadata() } : {}),
				content: [{ type: "text", text }],
			});
			return;
		}
		default:
			sendError(request.id, -32601, "Method not found");
	}
}

function isValidLegacyInitialize(parameters) {
	return (
		protocolEra === "legacy" &&
		isRecord(parameters) &&
		parameters.protocolVersion === LEGACY_PROTOCOL_VERSION &&
		isRecord(parameters.capabilities) &&
		isRecord(parameters.clientInfo)
	);
}

function validateEnvelope(parameters) {
	if (!isRecord(parameters)) {
		return "Missing the required 2026-07-28 request metadata envelope";
	}
	const metadata = parameters["_meta"];
	if (!isRecord(metadata)) {
		return "Missing the required 2026-07-28 request metadata envelope";
	}
	if (metadata[PROTOCOL_VERSION_META_KEY] !== MODERN_PROTOCOL_VERSION) {
		return "Unexpected MCP protocol version";
	}
	if (!isRecord(metadata[CLIENT_CAPABILITIES_META_KEY])) {
		return "Missing MCP client capabilities";
	}
	return undefined;
}

function serverMetadata() {
	return { [SERVER_INFO_META_KEY]: SERVER_INFO };
}

function sendResult(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordLifecycle(event, details = {}) {
	if (lifecycleFile === undefined) return;
	appendFileSync(
		lifecycleFile,
		JSON.stringify({ event, pid: process.pid, ...details }) + "\n",
		"utf8",
	);
}

function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	recordLifecycle("stop", { reason });
	process.exit(0);
}

function fail(error) {
	process.stderr.write(`Independent MCP fixture failed: ${String(error)}\n`);
	process.exit(1);
}
