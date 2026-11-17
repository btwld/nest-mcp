import { McpServerRuntimeError } from "./mcp-server.errors.ts";
import { McpServerRuntime } from "./mcp-server.runtime.ts";
import type { McpServerDefinition } from "./mcp-server.types.ts";

/** Mutable registry of named server runtimes with deterministic reverse-order shutdown. */
export class McpServerRegistry implements AsyncDisposable {
	readonly #runtimes = new Map<string, McpServerRuntime>();
	#closePromise: Promise<void> | undefined;
	#closing = false;

	constructor(definitions: readonly McpServerDefinition[] = []) {
		for (const definition of definitions) this.register(definition);
	}

	register(definition: McpServerDefinition): McpServerRuntime {
		this.#assertOpen();
		if (this.#runtimes.has(definition.name)) {
			throw new McpServerRuntimeError(
				"DUPLICATE_SERVER",
				`An MCP server named "${definition.name}" is already registered.`,
			);
		}
		const runtime = new McpServerRuntime(definition);
		this.#runtimes.set(runtime.name, runtime);
		return runtime;
	}

	registerRuntime(runtime: McpServerRuntime): McpServerRuntime {
		this.#assertOpen();
		if (this.#runtimes.has(runtime.name)) {
			throw new McpServerRuntimeError(
				"DUPLICATE_SERVER",
				`An MCP server named "${runtime.name}" is already registered.`,
			);
		}
		this.#runtimes.set(runtime.name, runtime);
		return runtime;
	}

	has(name: string): boolean {
		return this.#runtimes.has(name);
	}

	get(name: string): McpServerRuntime {
		const runtime = this.#runtimes.get(name);
		if (runtime === undefined) {
			throw new McpServerRuntimeError(
				"UNKNOWN_SERVER",
				`No MCP server named "${name}" is registered.`,
			);
		}
		return runtime;
	}

	list(): readonly McpServerRuntime[] {
		return [...this.#runtimes.values()];
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = Promise.resolve().then(() => this.#performClose());
		return this.#closePromise;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	async #performClose(): Promise<void> {
		const runtimes = [...this.#runtimes.values()].toReversed();
		this.#runtimes.clear();
		const settled = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
		const errors = settled.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (errors.length > 0) {
			throw new AggregateError(errors, "One or more MCP server runtimes failed to close.");
		}
	}

	#assertOpen(): void {
		if (this.#closing) {
			throw new McpServerRuntimeError("RUNTIME_CLOSED", "The MCP server registry is closed.");
		}
	}
}
