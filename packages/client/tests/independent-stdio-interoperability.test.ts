import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import { McpClientRuntime } from "../src/index.ts";

const FIXTURE_PATH = fileURLToPath(
	new URL("./fixtures/independent-modern-stdio-server.mjs", import.meta.url),
);

interface FixtureScenario {
	readonly era: "modern" | "legacy";
	readonly protocolVersion: string;
	readonly serverName: string;
	readonly sessionMethods: readonly string[];
}

const SCENARIOS = [
	{
		era: "modern",
		protocolVersion: "2026-07-28",
		serverName: "independent-modern-stdio-fixture",
		sessionMethods: ["tools/list", "tools/call"],
	},
	{
		era: "legacy",
		protocolVersion: "2025-11-25",
		serverName: "independent-legacy-stdio-fixture",
		sessionMethods: ["initialize", "notifications/initialized", "tools/list", "tools/call"],
	},
] as const satisfies readonly FixtureScenario[];

interface FixtureLifecycleEvent {
	readonly event: string;
	readonly pid: number;
	readonly method?: string;
	readonly code?: number;
}

describe("independent MCP server interoperability", () => {
	it("auto-negotiates modern and legacy hand-rolled stdio servers without leaking children", async () => {
		for (const scenario of SCENARIOS) await exerciseScenario(scenario);
	});
});

async function exerciseScenario(scenario: FixtureScenario): Promise<void> {
	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), `nest-mcp-independent-${scenario.era}-mcp-`),
	);
	const lifecycleFile = join(temporaryDirectory, "lifecycle.ndjson");
	const runtime = new McpClientRuntime({
		servers: [
			{
				name: "independent-stdio",
				transport: {
					kind: "stdio",
					command: process.execPath,
					args: [FIXTURE_PATH],
					env: {
						MCP_FIXTURE_ERA: scenario.era,
						MCP_FIXTURE_LIFECYCLE_FILE: lifecycleFile,
					},
					stderr: "pipe",
				},
			},
		],
	});
	let runtimeClosed = false;

	try {
		const client = await runtime.connect("independent-stdio");
		const transport = client.transport;
		if (!(transport instanceof StdioClientTransport)) {
			throw new TypeError("Expected the runtime to own a StdioClientTransport.");
		}
		const sessionPid = transport.pid;
		if (sessionPid === null) throw new Error("The stdio session child has no process ID.");
		const standardError: string[] = [];
		transport.stderr?.on("data", (chunk: unknown) => {
			standardError.push(toText(chunk));
		});

		const tools = await runtime.listTools("independent-stdio");
		const result = await runtime.callTool("independent-stdio", {
			name: "echo",
			arguments: { text: `${scenario.era} independent round trip` },
		});
		const activeEvents = await waitForLifecycle(lifecycleFile, (events) =>
			events.some(({ event, method }) => event === "request" && method === "tools/call"),
		);
		const startedPids = new Set(
			activeEvents.filter(({ event }) => event === "start").map(({ pid }) => pid),
		);
		const discoverEvent = activeEvents.find(
			({ event, method }) => event === "request" && method === "server/discover",
		);
		const sessionMethods = activeEvents
			.filter(
				({ event, pid }) => pid === sessionPid && (event === "request" || event === "notification"),
			)
			.map(({ method }) => method);

		expect(tools.tools.map(({ name }) => name)).toEqual(["echo"]);
		expect(result.content).toEqual([
			{ type: "text", text: `${scenario.era} independent round trip` },
		]);
		expect(runtime.snapshot("independent-stdio")).toMatchObject({
			state: "connected",
			transportKind: "stdio",
			protocolEra: scenario.era,
			negotiatedProtocolVersion: scenario.protocolVersion,
			serverInfo: { name: scenario.serverName, version: "1.0.0" },
		});
		expect(startedPids.size).toBe(2);
		expect(startedPids.has(sessionPid)).toBe(true);
		expect(discoverEvent).toBeDefined();
		expect(discoverEvent?.pid).not.toBe(sessionPid);
		expect(sessionMethods).toEqual(scenario.sessionMethods);
		if (discoverEvent !== undefined) await waitForProcessExit(discoverEvent.pid);
		expect(standardError.join("")).toBe("");

		await runtime.close();
		runtimeClosed = true;
		const stoppedEvents = await waitForLifecycle(lifecycleFile, (events) => {
			const exitedPids = new Set(
				events.filter(({ event }) => event === "exit").map(({ pid }) => pid),
			);
			return [...startedPids].every((pid) => exitedPids.has(pid));
		});
		const exitEvents = stoppedEvents.filter(({ event }) => event === "exit");

		expect(exitEvents).toHaveLength(startedPids.size);
		expect(exitEvents.every(({ code }) => code === 0)).toBe(true);
		for (const pid of startedPids) expect(isProcessAlive(pid)).toBe(false);
		expect(standardError.join("")).toBe("");
	} finally {
		try {
			if (!runtimeClosed) await runtime.close();
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	}
}

async function waitForLifecycle(
	path: string,
	predicate: (events: readonly FixtureLifecycleEvent[]) => boolean,
): Promise<readonly FixtureLifecycleEvent[]> {
	const deadline = Date.now() + 3_000;
	let events: readonly FixtureLifecycleEvent[] = [];
	do {
		events = await readLifecycle(path);
		if (predicate(events)) return events;
		await delay(10);
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for fixture lifecycle events: ${JSON.stringify(events)}`);
}

async function readLifecycle(path: string): Promise<readonly FixtureLifecycleEvent[]> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return [];
		throw error;
	}
	return contents
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => parseLifecycleEvent(line));
}

function parseLifecycleEvent(line: string): FixtureLifecycleEvent {
	const value: unknown = JSON.parse(line);
	if (
		typeof value !== "object" ||
		value === null ||
		!("event" in value) ||
		typeof value.event !== "string" ||
		!("pid" in value) ||
		typeof value.pid !== "number"
	) {
		throw new TypeError(`Invalid fixture lifecycle event: ${line}`);
	}
	const method = "method" in value && typeof value.method === "string" ? value.method : undefined;
	const code = "code" in value && typeof value.code === "number" ? value.code : undefined;
	return {
		event: value.event,
		pid: value.pid,
		...(method === undefined ? {} : { method }),
		...(code === undefined ? {} : { code }),
	};
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (isProcessAlive(pid) && Date.now() < deadline) await delay(10);
	if (isProcessAlive(pid)) throw new Error(`Fixture process ${String(pid)} did not exit.`);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isErrnoException(error) && error.code === "ESRCH") return false;
		throw error;
	}
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toText(chunk: unknown): string {
	if (typeof chunk === "string") return chunk;
	if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
	return String(chunk);
}
