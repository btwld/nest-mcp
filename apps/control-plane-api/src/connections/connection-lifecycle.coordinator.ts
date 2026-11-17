import { Injectable } from "@nestjs/common";

/** Serializes every authority and hub-membership mutation for one connection. */
@Injectable()
export class ConnectionLifecycleCoordinator {
	readonly #tails = new Map<string, Promise<void>>();

	async run<Result>(connectionId: string, operation: () => Promise<Result>): Promise<Result> {
		const predecessor = this.#tails.get(connectionId);
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#tails.set(connectionId, current);
		if (predecessor !== undefined) await predecessor;
		try {
			return await operation();
		} finally {
			release?.();
			if (this.#tails.get(connectionId) === current) this.#tails.delete(connectionId);
		}
	}
}
