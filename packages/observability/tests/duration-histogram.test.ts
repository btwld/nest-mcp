import { describe, expect, it } from "vitest";
import { McpDurationHistogram, addMcpMetricCount } from "../src/duration-histogram.ts";

describe("mergeable duration histogram", () => {
	const histogram = new McpDurationHistogram([5, 10, 100, Number.POSITIVE_INFINITY]);
	it("round-trips JSON sufficient statistics and merges disjoint histories without losing percentiles", () => {
		const all = histogram.create();
		const left = histogram.create();
		const right = histogram.create();
		for (const [index, value] of [0, 1.5, 5, 6, 10, 99, 101, 350].entries()) {
			histogram.record(all, value);
			histogram.record(index % 2 === 0 ? left : right, value);
		}
		const restored = histogram.restore(JSON.parse(JSON.stringify(histogram.snapshot(right))));
		histogram.merge(left, restored);
		expect(left).toEqual(all);
		expect(histogram.summarize(left)).toEqual({
			count: 8,
			averageMs: 71.5625,
			maxMs: 350,
			p50Ms: 10,
			p95Ms: 350,
		});
	});
	it("returns detached immutable snapshots and rejects mismatched geometry of the same length", () => {
		const state = histogram.create();
		histogram.record(state, 7);
		const snapshot = histogram.snapshot(state);
		histogram.record(state, 100);
		expect(snapshot.bins).toEqual([0, 1, 0, 0]);
		expect(Object.isFrozen(snapshot.bins)).toBe(true);
		expect(() => new McpDurationHistogram([1, 2, 3, Infinity]).restore(snapshot)).toThrow();
	});
	it("saturates counters and sums while keeping the maximum and mergeable bins", () => {
		const state = histogram.create();
		const max = Number.MAX_SAFE_INTEGER;
		histogram.merge(state, { count: max, sumMs: max, maxMs: 1, bins: [max, 0, 0, 0] });
		histogram.record(state, 100);
		expect(state).toEqual({ count: max, sumMs: max, maxMs: 100, bins: [max, 0, 1, 0] });
		expect(histogram.restore(histogram.snapshot(state))).toEqual(state);
		expect(addMcpMetricCount(max, 1)).toBe(max);
	});
	it("uses null for empty summary values and clamps estimates to the observed maximum", () => {
		const state = histogram.create();
		expect(histogram.summarize(state)).toEqual({
			count: 0,
			averageMs: null,
			maxMs: null,
			p50Ms: null,
			p95Ms: null,
		});
		histogram.record(state, 7);
		expect(histogram.percentile(state, 0.95)).toBe(7);
	});
	it("rejects invalid input before mutating an accumulator", () => {
		const state = histogram.create();
		for (const value of [-1, NaN, Infinity]) expect(() => histogram.record(state, value)).toThrow();
		expect(() =>
			histogram.merge(state, { count: 2, sumMs: 2, maxMs: 1, bins: [1, 0, 0, 0] }),
		).toThrow();
		expect(state).toEqual(histogram.create());
	});
	it.each(
		[[], [1, 2], [2, 1, Infinity], [1, 1, Infinity], [-1, Infinity], [NaN, Infinity]].map(
			(bounds) => ({ bounds }),
		),
	)("rejects invalid geometry $bounds", ({ bounds }) => {
		expect(() => new McpDurationHistogram(bounds)).toThrow();
	});
});
