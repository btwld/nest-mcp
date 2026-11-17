import type { MaybePromise } from "@nest-mcp/core";

import { McpGatewayError } from "./mcp-gateway.errors.ts";

interface GatewayLifecycleOptions {
	readonly shutdownTimeoutMs: number;
	readonly acceptedTasks: () => readonly Promise<unknown>[];
	readonly onClosing: (error: McpGatewayError) => void;
	readonly onClosed: () => void;
}

/** Owns gateway admission, cancellation, task tracking, and bounded quiescence. */
export class GatewayLifecycle {
	readonly #controller = new AbortController();
	readonly #activeTasks = new Set<Promise<unknown>>();
	readonly #options: GatewayLifecycleOptions;
	#closePromise: Promise<void> | undefined;
	#closing = false;

	constructor(options: GatewayLifecycleOptions) {
		this.#options = options;
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	assertOpen(): void {
		if (this.#closing) throw this.closedError();
	}

	track<Value>(work: () => MaybePromise<Value>): Promise<Value> {
		if (this.#closing) return Promise.reject(this.closedError());
		const task = (async (): Promise<Value> => {
			this.assertOpen();
			return await work();
		})();
		this.#activeTasks.add(task);
		void task.then(
			() => this.#activeTasks.delete(task),
			() => this.#activeTasks.delete(task),
		);
		return raceTaskWithSignal(task, this.#controller.signal);
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closing = true;
		const error = new McpGatewayError("GATEWAY_CLOSED", "The MCP gateway is closed.");
		// Publish the stable promise before abort listeners can synchronously re-enter close().
		this.#closePromise = Promise.resolve().then(() => this.#performClose());
		this.#controller.abort(error);
		this.#options.onClosing(error);
		return this.#closePromise;
	}

	closedError(): McpGatewayError {
		const reason = this.#controller.signal.reason;
		return reason instanceof McpGatewayError && reason.code === "GATEWAY_CLOSED"
			? reason
			: new McpGatewayError("GATEWAY_CLOSED", "The MCP gateway is closed.");
	}

	async #performClose(): Promise<void> {
		try {
			const acceptedTasks = [...this.#activeTasks, ...this.#options.acceptedTasks()];
			const settled = await settleWithin(acceptedTasks, this.#options.shutdownTimeoutMs);
			if (!settled) {
				throw new McpGatewayError(
					"GATEWAY_SHUTDOWN_TIMEOUT",
					`MCP gateway shutdown timed out after ${String(this.#options.shutdownTimeoutMs)}ms.`,
				);
			}
		} finally {
			this.#options.onClosed();
		}
	}
}

function raceTaskWithSignal<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<Value>((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function settleWithin(
	tasks: readonly Promise<unknown>[],
	timeoutMs: number,
): Promise<boolean> {
	if (tasks.length === 0) return true;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timeout = setTimeout(resolve, timeoutMs, false);
	});
	try {
		return await Promise.race([Promise.allSettled(tasks).then(() => true as const), expired]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
