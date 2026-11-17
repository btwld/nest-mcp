import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import { OAuthErrorCode, SdkErrorCode } from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const SERVER_NAME = "external-smoke";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MODERN_PROTOCOL_START = "2026-07-28";
const BUILD_TERMINATION_GRACE_MS = 250;
const ALLOWED_ERROR_CODES = new Set([
	...Object.values(SdkErrorCode),
	...Object.values(OAuthErrorCode),
	"ABORT_ERR",
	"MCP_CLIENT_RUNTIME_CLOSED",
	"MCP_CLIENT_SERVER_EXISTS",
	"MCP_CLIENT_SERVER_NOT_FOUND",
	"MCP_CLIENT_NOT_CONNECTED",
	"MCP_CLIENT_SHUTDOWN_TIMEOUT",
]);
const redactionValues = new Set();
const HELP = `Usage:
  pnpm --filter @nest-mcp/client smoke:external

The command reads configuration only from environment variables. It connects, performs the
protocol-appropriate liveness check, lists each advertised capability, optionally invokes one
tool, and prints a secret-free summary.

Common:
  MCP_SMOKE_TRANSPORT          http or stdio (required)
  MCP_SMOKE_PROTOCOL           auto, legacy, or a modern date >= 2026-07-28 (default: auto)
  MCP_SMOKE_TIMEOUT_MS         active-work timeout plus shutdown bound (default: 15000, max: 120000)
  MCP_SMOKE_TOOL_NAME          optional tool to invoke
  MCP_SMOKE_TOOL_ARGUMENTS_JSON  JSON object for the optional tool (default: {})

HTTP:
  MCP_SMOKE_URL                Streamable HTTP endpoint (required)
  MCP_SMOKE_AUTH               none, bearer, or oauth-client-credentials (default: none)
  MCP_SMOKE_BEARER_TOKEN       required for bearer
  MCP_SMOKE_OAUTH_CLIENT_ID    required for oauth-client-credentials
  MCP_SMOKE_OAUTH_CLIENT_SECRET  required for oauth-client-credentials
  MCP_SMOKE_OAUTH_EXPECTED_ISSUER required issuer binding for oauth-client-credentials
  MCP_SMOKE_OAUTH_SCOPE        optional space-separated scopes
  MCP_SMOKE_HTTP_HEADERS_JSON  optional JSON object of additional string headers
  MCP_SMOKE_ALLOW_INSECURE_HTTP=true permits non-loopback http:// targets

stdio:
  MCP_SMOKE_COMMAND            executable to spawn (required)
  MCP_SMOKE_ARGS_JSON          optional JSON array of string arguments
  MCP_SMOKE_CWD                optional child working directory
  MCP_SMOKE_STDIO_ENV_NAMES    comma-separated environment variable names to pass to the child
  MCP_SMOKE_STDIO_STDERR       ignore (default) or inherit; inherited output bypasses redaction

Safety:
  The command refuses to run when CI is set. MCP_SMOKE_ALLOW_CI=true is an explicit override for
  trusted, manually configured CI jobs. It is not part of the repository's default test/verify path.
`;

class SmokeConfigurationError extends Error {
	constructor(message) {
		super(message);
		this.name = "SmokeConfigurationError";
	}
}

async function main() {
	const commandArguments = process.argv.slice(2).filter((argument) => argument !== "--");
	if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
		process.stdout.write(HELP);
		return;
	}
	if (commandArguments.length > 0) {
		throw new SmokeConfigurationError(
			`Unexpected command argument. This command accepts environment variables only; use --help.`,
		);
	}

	assertCiOptIn(process.env);
	requireChoice(process.env, "MCP_SMOKE_TRANSPORT", new Set(["http", "stdio"]));
	const timeoutMs = readTimeout(process.env.MCP_SMOKE_TIMEOUT_MS);
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort(new Error("External MCP smoke test timed out."));
	}, timeoutMs);
	const abortForSignal = () => {
		abortController.abort(new Error("External MCP smoke test interrupted."));
	};
	process.once("SIGINT", abortForSignal);
	process.once("SIGTERM", abortForSignal);

	let runtime;
	let failure;
	let summary;
	try {
		const { ClientCredentialsProvider, McpClientRuntime } = await loadClientApi(
			abortController.signal,
		);
		abortController.signal.throwIfAborted();
		const configuration = loadConfiguration(
			process.env,
			redactionValues,
			ClientCredentialsProvider,
			timeoutMs,
		);
		abortController.signal.throwIfAborted();
		runtime = new McpClientRuntime({
			clientInfo: { name: "@nest-mcp/client-external-smoke", version: "1.0.0" },
			shutdownTimeoutMs: timeoutMs,
			servers: [
				{
					name: SERVER_NAME,
					transport: configuration.transport,
					clientOptions: {
						versionNegotiation: { mode: configuration.negotiationMode },
					},
				},
			],
		});

		const requestOptions = {
			signal: abortController.signal,
			timeout: timeoutMs,
			maxTotalTimeout: timeoutMs,
		};
		await runtime.connect(SERVER_NAME, requestOptions);
		let snapshot = runtime.snapshot(SERVER_NAME);
		const liveness = await probeProtocolLiveness(runtime, snapshot.protocolEra, requestOptions);
		snapshot = runtime.snapshot(SERVER_NAME);
		const probes = await probeAdvertisedCapabilities(
			runtime,
			snapshot.serverCapabilities,
			configuration.tool,
			requestOptions,
			liveness,
		);
		summary = {
			ok: true,
			transport: configuration.transport.kind,
			negotiation: configuration.negotiationLabel,
			state: snapshot.state,
			protocolEra: snapshot.protocolEra ?? null,
			protocolVersion: snapshot.negotiatedProtocolVersion ?? null,
			sessionIdAssigned: snapshot.sessionId !== undefined,
			probes,
		};
	} catch (error) {
		failure = error;
	} finally {
		clearTimeout(timeout);
		if (runtime !== undefined) {
			try {
				await runtime.close();
			} catch (error) {
				failure =
					failure === undefined
						? error
						: new AggregateError(
								[failure, error],
								"The smoke test and runtime cleanup both failed.",
							);
			}
		}
		if (failure === undefined && abortController.signal.aborted) {
			failure = abortReason(abortController.signal);
		}
		process.removeListener("SIGINT", abortForSignal);
		process.removeListener("SIGTERM", abortForSignal);
	}

	if (failure !== undefined) throw failure;
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function loadClientApi(signal) {
	const distribution = new URL("../dist/index.mjs", import.meta.url);
	const source = new URL("../src/index.ts", import.meta.url);
	if (await pathExists(source)) {
		await buildDevelopmentPackage(signal);
	} else if (!(await pathExists(distribution))) {
		throw new SmokeConfigurationError(
			"The package is incomplete: dist/index.mjs and the development source are both missing.",
		);
	}
	return import(distribution.href);
}

async function pathExists(url) {
	try {
		await access(url);
		return true;
	} catch {
		return false;
	}
}

async function buildDevelopmentPackage(signal) {
	const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
	await runPnpmBuild(workspaceRoot, "@nest-mcp/core", signal);
	await runPnpmBuild(workspaceRoot, "@nest-mcp/client", signal);
}

function runPnpmBuild(workspaceRoot, packageName, signal) {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		const child = spawn("pnpm", ["--filter", packageName, "run", "build"], {
			cwd: workspaceRoot,
			detached: process.platform !== "win32",
			env: getDefaultEnvironment(),
			stdio: "inherit",
		});
		let abortStarted = false;
		let childExited = false;
		let escalationComplete = false;
		let settled = false;
		let forceKillTimeout;

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		const settle = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
			if (error === undefined) resolve();
			else reject(error);
		};
		const finishAbortedBuild = () => {
			if (childExited && escalationComplete) settle(abortReason(signal));
		};
		const onAbort = () => {
			if (abortStarted || settled) return;
			abortStarted = true;
			terminateBuildProcess(child, "SIGTERM");
			forceKillTimeout = setTimeout(() => {
				terminateBuildProcess(child, "SIGKILL");
				escalationComplete = true;
				finishAbortedBuild();
			}, BUILD_TERMINATION_GRACE_MS);
		};

		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		child.once("spawn", () => {
			if (signal.aborted) terminateBuildProcess(child, "SIGTERM");
		});
		child.once("error", () => {
			settle(
				signal.aborted
					? abortReason(signal)
					: new SmokeConfigurationError(
							"The development build could not start; install pnpm or run the package build manually.",
						),
			);
		});
		child.once("exit", (code) => {
			childExited = true;
			if (signal.aborted) {
				if (!abortStarted) onAbort();
				finishAbortedBuild();
				return;
			}
			if (code === 0) {
				settle();
				return;
			}
			settle(new SmokeConfigurationError("The development package build failed."));
		});
	});
}

function terminateBuildProcess(child, signal) {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The exact child already exited between the PID check and termination request.
		}
	}
}

function abortReason(signal) {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("External MCP smoke test aborted.");
}

function loadConfiguration(environment, secretValues, ClientCredentialsProvider, timeoutMs) {
	const { mode: negotiationMode, label: negotiationLabel } = readNegotiationMode(
		environment.MCP_SMOKE_PROTOCOL,
	);
	const transportKind = requireChoice(
		environment,
		"MCP_SMOKE_TRANSPORT",
		new Set(["http", "stdio"]),
	);
	const transport =
		transportKind === "http"
			? loadHttpTransport(environment, secretValues, ClientCredentialsProvider)
			: loadStdioTransport(environment, secretValues);
	const toolName = optionalNonEmpty(environment.MCP_SMOKE_TOOL_NAME);
	const toolArgumentsRaw = environment.MCP_SMOKE_TOOL_ARGUMENTS_JSON;
	if (toolName === undefined && optionalNonEmpty(toolArgumentsRaw) !== undefined) {
		throw new SmokeConfigurationError(
			"MCP_SMOKE_TOOL_ARGUMENTS_JSON requires MCP_SMOKE_TOOL_NAME.",
		);
	}
	let tool;
	if (toolName !== undefined) {
		const toolArguments = readJsonObject(toolArgumentsRaw, "MCP_SMOKE_TOOL_ARGUMENTS_JSON", {});
		registerScalarSecrets(toolArguments, secretValues);
		tool = { name: toolName, arguments: toolArguments };
	}
	if (toolArgumentsRaw !== undefined) secretValues.add(toolArgumentsRaw);

	return {
		negotiationLabel,
		negotiationMode,
		timeoutMs,
		tool,
		transport,
	};
}

function loadHttpTransport(environment, secretValues, ClientCredentialsProvider) {
	const rawUrl = requireEnvironment(environment, "MCP_SMOKE_URL");
	secretValues.add(rawUrl);
	const url = readUrl(rawUrl, "MCP_SMOKE_URL");
	secretValues.add(url.href);
	if (url.username !== "" || url.password !== "") {
		throw new SmokeConfigurationError("MCP_SMOKE_URL must not contain URL credentials.");
	}
	if (
		url.protocol === "http:" &&
		!isLoopbackHostname(url.hostname) &&
		!isTrue(environment.MCP_SMOKE_ALLOW_INSECURE_HTTP)
	) {
		throw new SmokeConfigurationError(
			"Non-loopback http:// targets require MCP_SMOKE_ALLOW_INSECURE_HTTP=true.",
		);
	}

	const authMode = optionalNonEmpty(environment.MCP_SMOKE_AUTH) ?? "none";
	if (!new Set(["none", "bearer", "oauth-client-credentials"]).has(authMode)) {
		throw new SmokeConfigurationError(
			"MCP_SMOKE_AUTH must be none, bearer, or oauth-client-credentials.",
		);
	}
	const headers = readHeaders(environment.MCP_SMOKE_HTTP_HEADERS_JSON, secretValues);
	if (authMode !== "none" && headers.has("authorization")) {
		throw new SmokeConfigurationError(
			"Do not combine an Authorization header with MCP_SMOKE_AUTH.",
		);
	}

	let authProvider;
	if (authMode === "bearer") {
		const token = requireEnvironment(environment, "MCP_SMOKE_BEARER_TOKEN");
		secretValues.add(token);
		authProvider = { token: async () => token };
	}
	if (authMode === "oauth-client-credentials") {
		const clientId = requireEnvironment(environment, "MCP_SMOKE_OAUTH_CLIENT_ID");
		const clientSecret = requireEnvironment(environment, "MCP_SMOKE_OAUTH_CLIENT_SECRET");
		const expectedIssuer = requireEnvironment(environment, "MCP_SMOKE_OAUTH_EXPECTED_ISSUER");
		const issuerUrl = readUrl(expectedIssuer, "MCP_SMOKE_OAUTH_EXPECTED_ISSUER");
		if (issuerUrl.username !== "" || issuerUrl.password !== "") {
			throw new SmokeConfigurationError(
				"MCP_SMOKE_OAUTH_EXPECTED_ISSUER must not contain URL credentials.",
			);
		}
		if (issuerUrl.protocol === "http:" && !isLoopbackHostname(issuerUrl.hostname)) {
			throw new SmokeConfigurationError(
				"MCP_SMOKE_OAUTH_EXPECTED_ISSUER must use https:// unless it is loopback.",
			);
		}
		secretValues.add(clientId);
		secretValues.add(clientSecret);
		secretValues.add(expectedIssuer);
		authProvider = new ClientCredentialsProvider({
			clientId,
			clientSecret,
			expectedIssuer,
			...(optionalNonEmpty(environment.MCP_SMOKE_OAUTH_SCOPE) === undefined
				? {}
				: { scope: environment.MCP_SMOKE_OAUTH_SCOPE }),
		});
	}

	return {
		kind: "http",
		url,
		...(authProvider === undefined ? {} : { authProvider }),
		...(headers.size === 0 ? {} : { requestInit: { headers } }),
	};
}

function loadStdioTransport(environment, secretValues) {
	const command = requireEnvironment(environment, "MCP_SMOKE_COMMAND");
	const args = readJsonStringArray(environment.MCP_SMOKE_ARGS_JSON, "MCP_SMOKE_ARGS_JSON");
	const cwd = optionalNonEmpty(environment.MCP_SMOKE_CWD);
	const stderr = optionalNonEmpty(environment.MCP_SMOKE_STDIO_STDERR) ?? "ignore";
	if (stderr !== "ignore" && stderr !== "inherit") {
		throw new SmokeConfigurationError("MCP_SMOKE_STDIO_STDERR must be ignore or inherit.");
	}
	const environmentNames = readEnvironmentNames(environment.MCP_SMOKE_STDIO_ENV_NAMES);
	const childEnvironment = getDefaultEnvironment();
	for (const name of environmentNames) {
		const value = requireEnvironment(environment, name);
		childEnvironment[name] = value;
		secretValues.add(value);
	}
	for (const argument of args) secretValues.add(argument);

	return {
		kind: "stdio",
		command,
		args,
		env: childEnvironment,
		stderr,
		...(cwd === undefined ? {} : { cwd }),
	};
}

async function probeProtocolLiveness(runtime, protocolEra, requestOptions) {
	if (protocolEra === "legacy") {
		await runtime.ping(SERVER_NAME, requestOptions);
		return { discover: null, ping: true };
	}
	if (protocolEra === "modern") {
		await runtime.discover(SERVER_NAME, requestOptions);
		return { discover: true, ping: null };
	}
	throw new Error("The connected MCP server did not report a protocol era.");
}

async function probeAdvertisedCapabilities(runtime, capabilities, tool, requestOptions, liveness) {
	const probes = {
		discover: liveness.discover,
		ping: liveness.ping,
		tools: null,
		resources: null,
		prompts: null,
		toolInvoked: false,
	};
	let listedTools;
	if (hasCapability(capabilities, "tools") || tool !== undefined) {
		listedTools = await runtime.listTools(SERVER_NAME, undefined, requestOptions);
		probes.tools = listedTools.tools.length;
	}
	if (hasCapability(capabilities, "resources")) {
		const result = await runtime.listResources(SERVER_NAME, undefined, requestOptions);
		probes.resources = result.resources.length;
	}
	if (hasCapability(capabilities, "prompts")) {
		const result = await runtime.listPrompts(SERVER_NAME, undefined, requestOptions);
		probes.prompts = result.prompts.length;
	}
	if (tool !== undefined) {
		if (!listedTools?.tools.some((entry) => entry.name === tool.name)) {
			throw new SmokeConfigurationError(
				"MCP_SMOKE_TOOL_NAME is not present in the server's tools list.",
			);
		}
		const result = await runtime.callTool(
			SERVER_NAME,
			{ name: tool.name, arguments: tool.arguments },
			requestOptions,
		);
		if (result.isError === true) {
			throw new Error("The configured smoke-test tool returned isError=true.");
		}
		probes.toolInvoked = true;
	}
	return probes;
}

function hasCapability(capabilities, name) {
	return capabilities !== undefined && capabilities[name] !== undefined;
}

function readHeaders(raw, secretValues) {
	const values = readJsonObject(raw, "MCP_SMOKE_HTTP_HEADERS_JSON", {});
	const headers = new Headers();
	for (const [name, value] of Object.entries(values)) {
		if (typeof value !== "string") {
			throw new SmokeConfigurationError("MCP_SMOKE_HTTP_HEADERS_JSON values must all be strings.");
		}
		try {
			headers.set(name, value);
		} catch {
			throw new SmokeConfigurationError("MCP_SMOKE_HTTP_HEADERS_JSON contains an invalid header.");
		}
		secretValues.add(value);
	}
	if (raw !== undefined) secretValues.add(raw);
	return headers;
}

function readJsonObject(raw, name, fallback) {
	if (optionalNonEmpty(raw) === undefined) return fallback;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SmokeConfigurationError(`${name} must contain valid JSON.`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SmokeConfigurationError(`${name} must contain a JSON object.`);
	}
	return parsed;
}

function registerScalarSecrets(value, secretValues) {
	const pending = [value];
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (candidate === null) {
			secretValues.add("null");
			continue;
		}
		if (Array.isArray(candidate)) {
			for (const entry of candidate) pending.push(entry);
			continue;
		}
		if (typeof candidate === "object") {
			for (const entry of Object.values(candidate)) pending.push(entry);
			continue;
		}
		if (
			typeof candidate === "string" ||
			typeof candidate === "number" ||
			typeof candidate === "boolean"
		) {
			secretValues.add(String(candidate));
		}
	}
}

function readJsonStringArray(raw, name) {
	if (optionalNonEmpty(raw) === undefined) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SmokeConfigurationError(`${name} must contain valid JSON.`);
	}
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
		throw new SmokeConfigurationError(`${name} must contain a JSON array of strings.`);
	}
	return parsed;
}

function readEnvironmentNames(raw) {
	if (optionalNonEmpty(raw) === undefined) return [];
	const names = raw.split(",").map((name) => name.trim());
	if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
		throw new SmokeConfigurationError(
			"MCP_SMOKE_STDIO_ENV_NAMES must be a comma-separated list of environment names.",
		);
	}
	return [...new Set(names)];
}

function readNegotiationMode(raw) {
	const value = optionalNonEmpty(raw) ?? "auto";
	if (value === "auto" || value === "legacy") return { mode: value, label: value };
	if (!isCalendarDate(value) || value < MODERN_PROTOCOL_START) {
		throw new SmokeConfigurationError(
			`MCP_SMOKE_PROTOCOL must be auto, legacy, or a valid calendar date on or after ${MODERN_PROTOCOL_START}.`,
		);
	}
	return { mode: { pin: value }, label: `pin:${value}` };
}

function isCalendarDate(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) return false;
	const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= daysInMonth[month - 1];
}

function isLeapYear(year) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function readTimeout(raw) {
	if (optionalNonEmpty(raw) === undefined) return DEFAULT_TIMEOUT_MS;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) {
		throw new SmokeConfigurationError(
			`MCP_SMOKE_TIMEOUT_MS must be an integer from 100 to ${String(MAX_TIMEOUT_MS)}.`,
		);
	}
	return value;
}

function readUrl(raw, name) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new SmokeConfigurationError(`${name} must be an absolute http:// or https:// URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SmokeConfigurationError(`${name} must be an absolute http:// or https:// URL.`);
	}
	return url;
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost") return true;
	const unbracketed =
		hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	const ipVersion = isIP(unbracketed);
	if (ipVersion === 4) return unbracketed.split(".", 1)[0] === "127";
	return ipVersion === 6 && unbracketed === "::1";
}

function requireChoice(environment, name, choices) {
	const value = requireEnvironment(environment, name);
	if (!choices.has(value)) {
		throw new SmokeConfigurationError(`${name} must be one of: ${[...choices].join(", ")}.`);
	}
	return value;
}

function requireEnvironment(environment, name) {
	const value = environment[name];
	if (optionalNonEmpty(value) === undefined) {
		throw new SmokeConfigurationError(`Missing required environment variable: ${name}.`);
	}
	return value;
}

function optionalNonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function assertCiOptIn(environment) {
	if (optionalNonEmpty(environment.CI) !== undefined && !isTrue(environment.MCP_SMOKE_ALLOW_CI)) {
		throw new SmokeConfigurationError(
			"External MCP smoke tests are disabled when CI is set; use MCP_SMOKE_ALLOW_CI=true only in a trusted opt-in job.",
		);
	}
}

function isTrue(value) {
	return value === "true" || value === "1";
}

function errorSummary(error, secretValues) {
	if (!(error instanceof Error)) {
		return { name: "Error", message: "External MCP smoke test failed with a non-Error value." };
	}
	const summary = {
		name: error.name,
		message: redact(error.message || "External MCP smoke test failed.", secretValues),
	};
	const code = Reflect.get(error, "code");
	if (typeof code === "string" && ALLOWED_ERROR_CODES.has(code)) summary.code = code;
	return summary;
}

function redact(value, secretValues) {
	let redacted = value;
	const ordered = [...secretValues]
		.filter((secret) => typeof secret === "string" && secret.length > 0)
		.toSorted((left, right) => right.length - left.length);
	for (const secret of ordered) redacted = redacted.split(secret).join("[REDACTED]");
	return redacted;
}

try {
	await main();
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({ ok: false, error: errorSummary(error, redactionValues) }, null, 2)}\n`,
	);
	process.exitCode = 1;
}
