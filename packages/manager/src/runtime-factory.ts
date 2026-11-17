import { randomUUID } from "node:crypto";

import {
	McpClientRuntime,
	type McpClientLeaseFactoryContext,
	type McpClientRuntimeOptions,
} from "@nest-mcp/client";
import type { McpLifecycleObserver } from "@nest-mcp/core";

import {
	MCP_RUNTIME_CLEANUP_FAILED,
	McpRuntimeGenerationResolutionError,
	runtimeManagerErrorCode,
} from "./errors.ts";
import type { RuntimeStateStore } from "./runtime-state.ts";
import type { McpAdmittedRuntimeGeneration, McpRuntimeGenerationResolver } from "./types.ts";
import packageMetadata from "../package.json" with { type: "json" };

interface OwnedMcpRuntimeBase<GenerationKey> {
	readonly generationKey: GenerationKey;
	readonly generationSignal: AbortSignal;
	readonly admitted: McpAdmittedRuntimeGeneration;
}

export interface ActiveMcpRuntime<GenerationKey> extends OwnedMcpRuntimeBase<GenerationKey> {
	readonly runtime: McpClientRuntime;
	readonly serverName: string;
	readonly quarantined: false;
}

export interface QuarantinedMcpRuntime<GenerationKey> extends OwnedMcpRuntimeBase<GenerationKey> {
	readonly runtime?: McpClientRuntime;
	readonly serverName?: string;
	readonly quarantined: true;
}

export type OwnedMcpRuntime<GenerationKey> =
	ActiveMcpRuntime<GenerationKey> | QuarantinedMcpRuntime<GenerationKey>;

interface ManagedRuntimeFactoryOptions<GenerationKey> {
	readonly generationResolver: McpRuntimeGenerationResolver<GenerationKey>;
	readonly states: RuntimeStateStore<GenerationKey>;
	readonly requestTimeoutMs: number;
	readonly shutdownTimeoutMs: number;
	readonly maxDiscoveryPages: number;
	readonly clientInfo?: NonNullable<McpClientRuntimeOptions["clientInfo"]>;
	readonly observer?: McpLifecycleObserver;
	readonly now: () => number;
}

const DEFAULT_CLIENT_INFO = Object.freeze({
	name: "@nest-mcp/manager",
	version: packageMetadata.version,
});

export class ManagedRuntimeFactory<GenerationKey> {
	readonly #generationResolver: McpRuntimeGenerationResolver<GenerationKey>;
	readonly #states: RuntimeStateStore<GenerationKey>;
	readonly #requestTimeoutMs: number;
	readonly #shutdownTimeoutMs: number;
	readonly #maxDiscoveryPages: number;
	readonly #clientInfo: NonNullable<McpClientRuntimeOptions["clientInfo"]>;
	readonly #observer: McpLifecycleObserver | undefined;
	readonly #now: () => number;

	constructor(options: ManagedRuntimeFactoryOptions<GenerationKey>) {
		this.#generationResolver = options.generationResolver;
		this.#states = options.states;
		this.#requestTimeoutMs = options.requestTimeoutMs;
		this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
		this.#maxDiscoveryPages = options.maxDiscoveryPages;
		this.#clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
		this.#observer = options.observer;
		this.#now = options.now;
	}

	async create(
		generationKey: GenerationKey,
		context: McpClientLeaseFactoryContext,
	): Promise<OwnedMcpRuntime<GenerationKey>> {
		this.#states.transition(generationKey, "connecting");
		let admitted: McpAdmittedRuntimeGeneration;
		try {
			admitted = withSharedClose(
				await this.#generationResolver.resolve(generationKey, context.signal),
			);
		} catch (error) {
			this.#states.transition(generationKey, "failed", runtimeManagerErrorCode(error));
			throw new McpRuntimeGenerationResolutionError(error);
		}
		let serverName: string | undefined;
		let runtime: McpClientRuntime | undefined;
		try {
			serverName = `managed-${randomUUID()}`;
			runtime = new McpClientRuntime({
				clientInfo: this.#clientInfo,
				servers: [
					{
						name: serverName,
						transport: admitted.transport,
						clientOptions: {
							listMaxPages: this.#maxDiscoveryPages,
							versionNegotiation: { mode: "auto" },
						},
					},
				],
				shutdownTimeoutMs: this.#shutdownTimeoutMs,
				now: this.#now,
				...(this.#observer === undefined ? {} : { observer: this.#observer }),
			});
			await runtime.connect(serverName, {
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(this.#requestTimeoutMs)]),
			});
			const snapshot = this.#states.connected(generationKey, runtime.snapshot(serverName));
			await admitted.onConnected?.(snapshot, context.signal);
			context.signal.throwIfAborted();
			return Object.freeze({
				generationKey,
				generationSignal: context.signal,
				runtime,
				serverName,
				admitted,
				quarantined: false,
			});
		} catch (error) {
			this.#states.transition(generationKey, "failed", runtimeManagerErrorCode(error));
			try {
				await closeRuntimeThenMaterial(runtime, admitted, this.#shutdownTimeoutMs);
			} catch {
				this.#states.transition(generationKey, "quarantined", MCP_RUNTIME_CLEANUP_FAILED);
				return Object.freeze({
					generationKey,
					generationSignal: context.signal,
					admitted,
					...(runtime === undefined ? {} : { runtime }),
					...(serverName === undefined ? {} : { serverName }),
					quarantined: true,
				});
			}
			throw error;
		}
	}

	async close(owned: OwnedMcpRuntime<GenerationKey>): Promise<void> {
		this.#states.transition(owned.generationKey, "draining");
		try {
			await closeRuntimeThenMaterial(owned.runtime, owned.admitted, this.#shutdownTimeoutMs);
		} catch (error) {
			this.#states.transition(owned.generationKey, "quarantined", MCP_RUNTIME_CLEANUP_FAILED);
			throw error;
		}
		this.#states.transition(owned.generationKey, "offline");
	}
}

function withSharedClose(admitted: McpAdmittedRuntimeGeneration): McpAdmittedRuntimeGeneration {
	let closeTask: Promise<void> | undefined;
	return Object.freeze({
		transport: admitted.transport,
		...(admitted.onConnected === undefined
			? {}
			: { onConnected: admitted.onConnected.bind(admitted) }),
		close(): Promise<void> {
			closeTask ??= Promise.resolve().then(() => admitted.close());
			return closeTask;
		},
	});
}

async function closeRuntimeThenMaterial(
	runtime: McpClientRuntime | undefined,
	admitted: McpAdmittedRuntimeGeneration,
	shutdownTimeoutMs: number,
): Promise<void> {
	const failures: unknown[] = [];
	if (runtime !== undefined) {
		try {
			await runtime.close();
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		await withCleanupTimeout(admitted.close(), shutdownTimeoutMs);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, "An MCP runtime generation could not be closed.");
	}
}

function withCleanupTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("The admitted MCP runtime material did not close before its deadline."));
		}, timeoutMs);
		timer.unref?.();
		void task.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
