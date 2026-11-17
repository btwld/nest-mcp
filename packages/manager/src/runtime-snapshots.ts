import type { StandardSchemaV1, StandardSchemaV1Sync } from "@modelcontextprotocol/client";

import { isRuntimeStateErrorCode, type McpRuntimeStateErrorCode } from "./errors.ts";
import type {
	McpRuntimeCapabilitiesSnapshot,
	McpRuntimePhase,
	McpRuntimeProbeSnapshot,
	McpRuntimeProtocolEra,
	McpRuntimeStateSnapshot,
} from "./types.ts";

/**
 * Resolves to `Members` only when the tuple lists every member of `Union`.
 *
 * A union member that no entry covers collapses this to `never`, which fails
 * the `satisfies` fence at its declaration. An entry that is not a union member
 * fails the same fence through the `Members` constraint, so a union and its
 * published tuple cannot drift apart without a compile error.
 */
type McpExhaustiveMembers<Union extends string, Members extends readonly Union[]> = [
	Union,
] extends [Members[number]]
	? Members
	: never;

const RUNTIME_PHASE_MEMBERS = [
	"offline",
	"queued",
	"connecting",
	"online",
	"degraded",
	"draining",
	"failed",
	"quarantined",
] as const;

const PROTOCOL_ERA_MEMBERS = ["legacy", "modern"] as const;

const CAPABILITY_MEMBERS = [
	"tools",
	"resources",
	"prompts",
	"completion",
	"subscriptions",
] as const;

const STATE_MEMBERS = [
	"phase",
	"lastTransitionAt",
	"protocolVersion",
	"protocolEra",
	"connectedAt",
	"errorCode",
	"capabilities",
] as const;

const PROBE_MEMBERS = [
	"reachable",
	"observedAt",
	"protocolVersion",
	"protocolEra",
	"capabilities",
	"runtime",
] as const;

/** Every `McpRuntimePhase`, in lifecycle order, for hosts that persist state projections. */
export const MCP_RUNTIME_PHASES = Object.freeze(
	RUNTIME_PHASE_MEMBERS satisfies McpExhaustiveMembers<
		McpRuntimePhase,
		typeof RUNTIME_PHASE_MEMBERS
	>,
);

/** Every `McpRuntimeProtocolEra` a connected managed generation can report. */
export const MCP_RUNTIME_PROTOCOL_ERAS = Object.freeze(
	PROTOCOL_ERA_MEMBERS satisfies McpExhaustiveMembers<
		McpRuntimeProtocolEra,
		typeof PROTOCOL_ERA_MEMBERS
	>,
);

const RUNTIME_PHASES: ReadonlySet<string> = new Set(MCP_RUNTIME_PHASES);
const PROTOCOL_ERAS: ReadonlySet<string> = new Set(MCP_RUNTIME_PROTOCOL_ERAS);

const CAPABILITY_KEYS: ReadonlySet<string> = new Set(
	CAPABILITY_MEMBERS satisfies McpExhaustiveMembers<
		keyof McpRuntimeCapabilitiesSnapshot,
		typeof CAPABILITY_MEMBERS
	>,
);

const STATE_KEYS: ReadonlySet<string> = new Set(
	STATE_MEMBERS satisfies McpExhaustiveMembers<keyof McpRuntimeStateSnapshot, typeof STATE_MEMBERS>,
);

const PROBE_KEYS: ReadonlySet<string> = new Set(
	PROBE_MEMBERS satisfies McpExhaustiveMembers<keyof McpRuntimeProbeSnapshot, typeof PROBE_MEMBERS>,
);

const ISO_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const SNAPSHOT_SCHEMA_VENDOR = "@nest-mcp/manager";

/**
 * Standard Schema v1 validator for one snapshot shape produced by the manager.
 *
 * Validation is synchronous and dependency-free. It accepts exactly what the
 * manager itself emits, rejects unknown properties, and returns a frozen
 * normalized snapshot so persisting a validated value round-trips unchanged.
 *
 * @see https://standardschema.dev
 */
export type McpRuntimeSnapshotSchema<Snapshot> = StandardSchemaV1Sync<unknown, Snapshot>;

type McpRuntimeSnapshotParser<Snapshot> = (
	value: unknown,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
) => Snapshot | undefined;

/** Validates a persisted `McpRuntimeCapabilitiesSnapshot`. */
export const mcpRuntimeCapabilitiesSnapshotSchema: McpRuntimeSnapshotSchema<McpRuntimeCapabilitiesSnapshot> =
	snapshotSchema(parseCapabilitiesSnapshot);

/** Validates a persisted `McpRuntimeStateSnapshot`, including an optional capability projection. */
export const mcpRuntimeStateSnapshotSchema: McpRuntimeSnapshotSchema<McpRuntimeStateSnapshot> =
	snapshotSchema(parseStateSnapshot);

/** Validates a persisted `McpRuntimeProbeSnapshot`, including its nested state projection. */
export const mcpRuntimeProbeSnapshotSchema: McpRuntimeSnapshotSchema<McpRuntimeProbeSnapshot> =
	snapshotSchema(parseProbeSnapshot);

function snapshotSchema<Snapshot>(
	parse: McpRuntimeSnapshotParser<Snapshot>,
): McpRuntimeSnapshotSchema<Snapshot> {
	const standard: McpRuntimeSnapshotSchema<Snapshot>["~standard"] = {
		version: 1,
		vendor: SNAPSHOT_SCHEMA_VENDOR,
		validate(value: unknown): StandardSchemaV1.Result<Snapshot> {
			const issues: StandardSchemaV1.Issue[] = [];
			const snapshot = parse(value, [], issues);
			if (snapshot === undefined || issues.length > 0) {
				return {
					issues: Object.freeze(
						issues.length > 0 ? issues : [issue("Expected a valid snapshot.", [])],
					),
				};
			}
			return { value: snapshot };
		},
	};
	return Object.freeze({ "~standard": Object.freeze(standard) });
}

function parseCapabilitiesSnapshot(
	value: unknown,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeCapabilitiesSnapshot | undefined {
	const source = readObject(value, path, issues);
	if (source === undefined) return undefined;
	rejectUnknownKeys(source, CAPABILITY_KEYS, path, issues);
	const issueCount = issues.length;
	const capabilities = Object.freeze({
		tools: readBoolean(source, "tools", path, issues),
		resources: readBoolean(source, "resources", path, issues),
		prompts: readBoolean(source, "prompts", path, issues),
		completion: readBoolean(source, "completion", path, issues),
		subscriptions: readBoolean(source, "subscriptions", path, issues),
	});
	return issues.length > issueCount ? undefined : capabilities;
}

function parseStateSnapshot(
	value: unknown,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeStateSnapshot | undefined {
	const source = readObject(value, path, issues);
	if (source === undefined) return undefined;
	rejectUnknownKeys(source, STATE_KEYS, path, issues);
	const issueCount = issues.length;
	const phase = readPhase(source, path, issues);
	const lastTransitionAt = readRequiredTimestamp(source, "lastTransitionAt", path, issues);
	const protocolVersion = readText(source, "protocolVersion", path, issues);
	const protocolEra = readProtocolEra(source, path, issues);
	const connectedAt = readOptionalTimestamp(source, "connectedAt", path, issues);
	const errorCode = readErrorCode(source, path, issues);
	const capabilities = readCapabilities(source, path, issues);
	if (phase === undefined || lastTransitionAt === undefined || issues.length > issueCount) {
		return undefined;
	}
	return Object.freeze({
		phase,
		lastTransitionAt,
		...(protocolVersion === undefined ? {} : { protocolVersion }),
		...(protocolEra === undefined ? {} : { protocolEra }),
		...(connectedAt === undefined ? {} : { connectedAt }),
		...(errorCode === undefined ? {} : { errorCode }),
		...(capabilities === undefined ? {} : { capabilities }),
	});
}

function parseProbeSnapshot(
	value: unknown,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeProbeSnapshot | undefined {
	const source = readObject(value, path, issues);
	if (source === undefined) return undefined;
	rejectUnknownKeys(source, PROBE_KEYS, path, issues);
	const issueCount = issues.length;
	if (Reflect.get(source, "reachable") !== true) {
		issues.push(issue("Expected the literal value true.", [...path, "reachable"]));
	}
	const observedAt = readRequiredTimestamp(source, "observedAt", path, issues);
	const protocolVersion = readText(source, "protocolVersion", path, issues);
	const protocolEra = readProtocolEra(source, path, issues);
	const capabilities = readCapabilities(source, path, issues);
	const runtime = readRuntimeState(source, path, issues);
	if (observedAt === undefined || runtime === undefined || issues.length > issueCount) {
		return undefined;
	}
	return Object.freeze({
		reachable: true as const,
		observedAt,
		...(protocolVersion === undefined ? {} : { protocolVersion }),
		...(protocolEra === undefined ? {} : { protocolEra }),
		...(capabilities === undefined ? {} : { capabilities }),
		runtime,
	});
}

function readObject(
	value: unknown,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): object | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(issue("Expected an object.", path));
		return undefined;
	}
	return value;
}

function rejectUnknownKeys(
	source: object,
	known: ReadonlySet<string>,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): void {
	for (const key of Object.keys(source)) {
		if (known.has(key)) continue;
		issues.push(issue("Unrecognized property.", [...path, key]));
	}
}

function readBoolean(
	source: object,
	key: string,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): boolean {
	const value: unknown = Reflect.get(source, key);
	if (typeof value === "boolean") return value;
	issues.push(issue("Expected a boolean.", [...path, key]));
	return false;
}

function readPhase(
	source: object,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimePhase | undefined {
	const value: unknown = Reflect.get(source, "phase");
	if (typeof value === "string" && isRuntimePhase(value)) return value;
	issues.push(issue(expectedOneOf(MCP_RUNTIME_PHASES), [...path, "phase"]));
	return undefined;
}

function readProtocolEra(
	source: object,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeProtocolEra | undefined {
	const value: unknown = Reflect.get(source, "protocolEra");
	if (value === undefined) return undefined;
	if (typeof value === "string" && isProtocolEra(value)) return value;
	issues.push(issue(expectedOneOf(MCP_RUNTIME_PROTOCOL_ERAS), [...path, "protocolEra"]));
	return undefined;
}

function readErrorCode(
	source: object,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeStateErrorCode | undefined {
	const value: unknown = Reflect.get(source, "errorCode");
	if (value === undefined) return undefined;
	if (typeof value === "string" && isRuntimeStateErrorCode(value)) return value;
	issues.push(issue("Expected a known MCP runtime state error code.", [...path, "errorCode"]));
	return undefined;
}

function readCapabilities(
	source: object,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeCapabilitiesSnapshot | undefined {
	const value: unknown = Reflect.get(source, "capabilities");
	if (value === undefined) return undefined;
	return parseCapabilitiesSnapshot(value, [...path, "capabilities"], issues);
}

function readRuntimeState(
	source: object,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): McpRuntimeStateSnapshot | undefined {
	const value: unknown = Reflect.get(source, "runtime");
	const runtimePath = [...path, "runtime"];
	if (value === undefined) {
		issues.push(issue("Expected a required value.", runtimePath));
		return undefined;
	}
	return parseStateSnapshot(value, runtimePath, issues);
}

function readText(
	source: object,
	key: string,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): string | undefined {
	const value: unknown = Reflect.get(source, key);
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.length > 0) return value;
	issues.push(issue("Expected a non-empty string.", [...path, key]));
	return undefined;
}

function readRequiredTimestamp(
	source: object,
	key: string,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): string | undefined {
	if (Reflect.get(source, key) === undefined) {
		issues.push(issue("Expected a required value.", [...path, key]));
		return undefined;
	}
	return readOptionalTimestamp(source, key, path, issues);
}

function readOptionalTimestamp(
	source: object,
	key: string,
	path: readonly PropertyKey[],
	issues: StandardSchemaV1.Issue[],
): string | undefined {
	const value: unknown = Reflect.get(source, key);
	if (value === undefined) return undefined;
	if (typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && isResolvedInstant(value)) {
		return value;
	}
	issues.push(issue("Expected an ISO 8601 date-time string.", [...path, key]));
	return undefined;
}

function issue(message: string, path: readonly PropertyKey[]): StandardSchemaV1.Issue {
	return Object.freeze({ message, path: Object.freeze([...path]) });
}

function expectedOneOf(members: readonly string[]): string {
	return `Expected one of ${members.join(", ")}.`;
}

function isRuntimePhase(value: string): value is McpRuntimePhase {
	return RUNTIME_PHASES.has(value);
}

function isProtocolEra(value: string): value is McpRuntimeProtocolEra {
	return PROTOCOL_ERAS.has(value);
}

function isResolvedInstant(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}
