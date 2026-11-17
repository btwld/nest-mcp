import type { McpClientConnectionSnapshot } from "@nest-mcp/client";

import type { McpRuntimeStateErrorCode } from "./errors.ts";
import type {
	McpRuntimePhase,
	McpRuntimeStateListener,
	McpRuntimeStateSnapshot,
	McpRuntimeStateTransitionEvent,
} from "./types.ts";

interface RuntimeStateStoreOptions {
	readonly now: () => number;
	readonly maxEntries: number;
	readonly onListenerError?: (
		error: unknown,
		event: McpRuntimeStateTransitionEvent,
	) => void | PromiseLike<void>;
}

export class RuntimeStateStore<GenerationKey> {
	readonly #states = new Map<GenerationKey, McpRuntimeStateSnapshot>();
	readonly #listeners = new Set<McpRuntimeStateListener>();
	readonly #now: () => number;
	readonly #maxEntries: number;
	readonly #onListenerError:
		| ((error: unknown, event: McpRuntimeStateTransitionEvent) => void | PromiseLike<void>)
		| undefined;

	constructor(options: RuntimeStateStoreOptions) {
		this.#now = options.now;
		this.#maxEntries = options.maxEntries;
		this.#onListenerError = options.onListenerError;
	}

	get size(): number {
		return this.#states.size;
	}

	read(generationKey: GenerationKey): McpRuntimeStateSnapshot {
		const current = this.#states.get(generationKey);
		if (current !== undefined) return current;
		return offlineState(readTimestamp(this.#now));
	}

	transition(
		generationKey: GenerationKey,
		phase: McpRuntimePhase,
		errorCode?: McpRuntimeStateErrorCode,
	): McpRuntimeStateSnapshot {
		const previous = this.#states.get(generationKey);
		if (previous?.phase === "quarantined") return previous;
		const timestamp = readTimestamp(this.#now);
		const lastTransitionAt =
			previous?.phase === phase && previous.errorCode === errorCode
				? previous.lastTransitionAt
				: new Date(timestamp).toISOString();
		const { errorCode: previousError, ...previousWithoutError } = previous ?? {};
		void previousError;
		const retainConnectionMetadata = phase === "degraded" || phase === "draining";
		const state: McpRuntimeStateSnapshot = Object.freeze({
			...(retainConnectionMetadata ? previousWithoutError : {}),
			phase,
			lastTransitionAt,
			...(errorCode === undefined ? {} : { errorCode }),
		});
		this.#set(generationKey, state);
		this.#publish(previous, state, timestamp);
		return state;
	}

	connected(
		generationKey: GenerationKey,
		snapshot: McpClientConnectionSnapshot,
	): McpRuntimeStateSnapshot {
		const capabilities = snapshot.serverCapabilities;
		const previous = this.#states.get(generationKey);
		if (previous?.phase === "quarantined") return previous;
		const timestamp = readTimestamp(this.#now);
		const state: McpRuntimeStateSnapshot = Object.freeze({
			phase: "online",
			lastTransitionAt:
				previous?.phase === "online"
					? previous.lastTransitionAt
					: new Date(timestamp).toISOString(),
			...(snapshot.negotiatedProtocolVersion === undefined
				? {}
				: { protocolVersion: snapshot.negotiatedProtocolVersion }),
			...(snapshot.protocolEra === undefined ? {} : { protocolEra: snapshot.protocolEra }),
			...(snapshot.connectedAt === undefined
				? {}
				: { connectedAt: new Date(snapshot.connectedAt).toISOString() }),
			...(capabilities === undefined
				? {}
				: {
						capabilities: Object.freeze({
							tools: capabilities.tools !== undefined,
							resources: capabilities.resources !== undefined,
							prompts: capabilities.prompts !== undefined,
							completion: capabilities.completions !== undefined,
							subscriptions: capabilities.resources?.subscribe === true,
						}),
					}),
		});
		this.#set(generationKey, state);
		this.#publish(previous, state, timestamp);
		return state;
	}

	forget(generationKey: GenerationKey): void {
		this.#states.delete(generationKey);
	}

	#set(generationKey: GenerationKey, state: McpRuntimeStateSnapshot): void {
		if (this.#states.delete(generationKey)) {
			this.#states.set(generationKey, state);
			return;
		}
		if (this.#states.size >= this.#maxEntries) {
			for (const [candidateKey, candidate] of this.#states) {
				if (candidate.phase !== "offline" && candidate.phase !== "failed") continue;
				this.#states.delete(candidateKey);
				break;
			}
			if (this.#states.size >= this.#maxEntries) return;
		}
		this.#states.set(generationKey, state);
	}

	subscribe(listener: McpRuntimeStateListener): () => void {
		if (typeof listener !== "function") {
			throw new TypeError("MCP runtime state listener must be a function.");
		}
		this.#listeners.add(listener);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.#listeners.delete(listener);
		};
	}

	#publish(
		previous: McpRuntimeStateSnapshot | undefined,
		current: McpRuntimeStateSnapshot,
		timestamp: number,
	): void {
		if (previous?.phase === current.phase && previous.errorCode === current.errorCode) return;
		const event: McpRuntimeStateTransitionEvent = Object.freeze({
			type: "runtime.state.changed",
			timestamp,
			...(previous === undefined
				? { previousPhase: "offline" as const }
				: { previousPhase: previous.phase }),
			phase: current.phase,
			...(current.errorCode === undefined ? {} : { errorCode: current.errorCode }),
			...(current.protocolEra === undefined ? {} : { protocolEra: current.protocolEra }),
			...(current.capabilities === undefined ? {} : { capabilities: current.capabilities }),
		});
		for (const listener of Array.from(this.#listeners)) {
			try {
				const result = listener(event);
				if (isPromiseLike(result)) {
					void Promise.resolve(result).catch((error: unknown) => {
						this.#reportListenerError(error, event);
					});
				}
			} catch (error) {
				this.#reportListenerError(error, event);
			}
		}
	}

	#reportListenerError(error: unknown, event: McpRuntimeStateTransitionEvent): void {
		if (this.#onListenerError === undefined) return;
		try {
			const result = this.#onListenerError(error, event);
			if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
		} catch {
			// Diagnostics must not replace the runtime lifecycle result.
		}
	}
}

function offlineState(timestamp: number): McpRuntimeStateSnapshot {
	return Object.freeze({
		phase: "offline",
		lastTransitionAt: new Date(timestamp).toISOString(),
	});
}

function readTimestamp(now: () => number): number {
	try {
		const timestamp = now();
		if (Number.isFinite(timestamp)) {
			new Date(timestamp).toISOString();
			return timestamp;
		}
	} catch {
		// The fallback keeps lifecycle state available even when an injected clock fails.
	}
	return Date.now();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}
