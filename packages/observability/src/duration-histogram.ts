/** Mergeable sufficient statistics. No host dimensions, storage, clock, or telemetry sink. */
export interface McpDurationHistogramData {
	readonly count: number;
	readonly sumMs: number;
	readonly maxMs: number;
	readonly bins: readonly number[];
}

export interface McpDurationHistogramState {
	count: number;
	sumMs: number;
	maxMs: number;
	readonly bins: number[];
}

/** JSON-safe geometry: the final unbounded bucket is represented by null. */
export interface McpDurationHistogramSnapshot extends McpDurationHistogramData {
	readonly version: 1;
	readonly upperBoundsMs: readonly (number | null)[];
}

/** Nonnegative counter addition with Number.MAX_SAFE_INTEGER saturation. */
export function addMcpMetricCount(current: number, increment: number): number {
	if (
		!Number.isSafeInteger(current) ||
		current < 0 ||
		!Number.isSafeInteger(increment) ||
		increment < 0
	)
		throw invalid();
	return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

/**
 * Configurable arithmetic shared by process-local collectors and durable hosts. Mutable states
 * belong to one configured geometry. Persist snapshot() and use restore() to reject incompatible
 * geometry; hosts with an existing versioned schema may supply its already-bound data directly.
 */
export class McpDurationHistogram {
	readonly upperBoundsMs: readonly number[];

	constructor(upperBoundsMs: readonly number[]) {
		if (
			!Array.isArray(upperBoundsMs) ||
			upperBoundsMs.length < 1 ||
			upperBoundsMs.length > 128 ||
			upperBoundsMs.at(-1) !== Number.POSITIVE_INFINITY ||
			Array.from(upperBoundsMs).some(
				(bound, index) =>
					(index < upperBoundsMs.length - 1 &&
						(!Number.isFinite(bound) || bound < 0 || bound > Number.MAX_SAFE_INTEGER)) ||
					(index > 0 && bound <= upperBoundsMs[index - 1]!),
			)
		)
			throw invalid();
		this.upperBoundsMs = Object.freeze([...upperBoundsMs]);
		Object.freeze(this);
	}

	create(): McpDurationHistogramState {
		return { count: 0, sumMs: 0, maxMs: 0, bins: this.upperBoundsMs.map(() => 0) };
	}

	bin(durationMs: number): number {
		assertDuration(durationMs);
		return this.upperBoundsMs.findIndex((bound) => durationMs <= bound);
	}

	record(target: McpDurationHistogramState, durationMs: number): void {
		this.#validate(target);
		const bin = this.bin(durationMs);
		target.count = addMcpMetricCount(target.count, 1);
		target.sumMs = Math.min(Number.MAX_SAFE_INTEGER, target.sumMs + durationMs);
		target.maxMs = Math.max(target.maxMs, durationMs);
		target.bins[bin] = addMcpMetricCount(target.bins[bin]!, 1);
	}

	merge(target: McpDurationHistogramState, source: McpDurationHistogramData): void {
		this.#validate(target);
		this.#validate(source);
		target.count = addMcpMetricCount(target.count, source.count);
		target.sumMs = Math.min(Number.MAX_SAFE_INTEGER, target.sumMs + source.sumMs);
		target.maxMs = Math.max(target.maxMs, source.maxMs);
		for (let index = 0; index < target.bins.length; index += 1)
			target.bins[index] = addMcpMetricCount(target.bins[index]!, source.bins[index]!);
	}

	percentile(data: McpDurationHistogramData, percentile: number): number | null {
		this.#validate(data);
		if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) throw invalid();
		if (data.count === 0) return null;
		const target = Math.max(1, Math.ceil(data.count * percentile));
		let cumulative = 0;
		for (const [index, count] of data.bins.entries()) {
			cumulative = addMcpMetricCount(cumulative, count);
			if (cumulative >= target) return Math.min(this.upperBoundsMs[index]!, data.maxMs);
		}
		return data.maxMs;
	}

	summarize(data: McpDurationHistogramData) {
		this.#validate(data);
		return Object.freeze({
			count: data.count,
			averageMs: data.count === 0 ? null : data.sumMs / data.count,
			maxMs: data.count === 0 ? null : data.maxMs,
			p50Ms: this.percentile(data, 0.5),
			p95Ms: this.percentile(data, 0.95),
		});
	}

	snapshot(data: McpDurationHistogramData): McpDurationHistogramSnapshot {
		this.#validate(data);
		return Object.freeze({
			version: 1 as const,
			upperBoundsMs: Object.freeze(
				this.upperBoundsMs.map((bound) => (Number.isFinite(bound) ? bound : null)),
			),
			count: data.count,
			sumMs: data.sumMs,
			maxMs: data.maxMs,
			bins: Object.freeze([...data.bins]),
		});
	}

	restore(value: unknown): McpDurationHistogramState {
		if (!isRecord(value)) throw invalid();
		const record = value;
		if (
			Object.keys(record).some(
				(key) => !["version", "upperBoundsMs", "count", "sumMs", "maxMs", "bins"].includes(key),
			) ||
			record.version !== 1 ||
			!Array.isArray(record.upperBoundsMs) ||
			record.upperBoundsMs.length !== this.upperBoundsMs.length ||
			Array.from(record.upperBoundsMs).some(
				(bound: unknown, index: number) =>
					bound !== (Number.isFinite(this.upperBoundsMs[index]) ? this.upperBoundsMs[index] : null),
			) ||
			typeof record.count !== "number" ||
			typeof record.sumMs !== "number" ||
			typeof record.maxMs !== "number" ||
			!Array.isArray(record.bins)
		)
			throw invalid();
		const bins: unknown[] = record.bins;
		if (!bins.every((count): count is number => typeof count === "number")) throw invalid();
		const result = {
			count: record.count,
			sumMs: record.sumMs,
			maxMs: record.maxMs,
			bins: [...bins],
		};
		this.#validate(result);
		return result;
	}

	#validate(data: McpDurationHistogramData): void {
		if (
			!Number.isSafeInteger(data.count) ||
			data.count < 0 ||
			!Array.isArray(data.bins) ||
			data.bins.length !== this.upperBoundsMs.length
		)
			throw invalid();
		assertDuration(data.sumMs);
		assertDuration(data.maxMs);
		if (
			Array.from(data.bins).reduce((total, count) => addMcpMetricCount(total, count), 0) !==
				data.count ||
			data.maxMs > data.sumMs ||
			(data.count === 0 && (data.sumMs !== 0 || data.maxMs !== 0))
		)
			throw invalid();
	}
}

function assertDuration(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw invalid();
}

function invalid(): TypeError {
	return new TypeError("The MCP duration histogram data or geometry is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
