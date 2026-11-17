import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { InMemoryMcpGatewayDiscoveryCache } from "../src/index.ts";

const ECHO_TOOL = {
	name: "echo",
	description: "Echo input",
	inputSchema: { type: "object", properties: { value: { type: "string" } } },
} satisfies Tool;

describe("InMemoryMcpGatewayDiscoveryCache", () => {
	it("isolates snapshots by authorization context and expires each entry by TTL", () => {
		let now = 1_000;
		const cache = new InMemoryMcpGatewayDiscoveryCache({ ttlMs: 100, now: () => now });
		const alice = { upstreamName: "tools", authorizationContext: "alice" };
		const bob = { upstreamName: "tools", authorizationContext: "bob" };

		cache.set(alice, { tools: [ECHO_TOOL], discoveredAt: now });
		now += 50;
		cache.set(bob, {
			tools: [{ ...ECHO_TOOL, name: "private-echo" }],
			discoveredAt: now,
		});

		expect(cache.get(alice)?.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(cache.get(bob)?.tools.map((tool) => tool.name)).toEqual(["private-echo"]);

		now = 1_100;
		expect(cache.get(alice)).toBeUndefined();
		expect(cache.get(bob)?.tools.map((tool) => tool.name)).toEqual(["private-echo"]);

		now = 1_150;
		expect(cache.get(bob)).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("copies and freezes snapshots before storing them", () => {
		const cache = new InMemoryMcpGatewayDiscoveryCache();
		const key = { upstreamName: "tools", authorizationContext: "alice" };
		const tool = structuredClone(ECHO_TOOL);
		cache.set(key, { tools: [tool], discoveredAt: 1 });

		tool.name = "mutated";
		const cached = cache.get(key);
		expect(cached?.tools[0]?.name).toBe("echo");
		expect(Object.isFrozen(cached)).toBe(true);
		expect(Object.isFrozen(cached?.tools[0]?.inputSchema)).toBe(true);
	});

	it("evicts least-recently-used snapshots by total byte weight", () => {
		const cache = new InMemoryMcpGatewayDiscoveryCache({
			maxEntries: 10,
			maxTotalBytes: 700,
		});
		const alice = { upstreamName: "tools", authorizationContext: "alice" };
		const bob = { upstreamName: "tools", authorizationContext: "bob" };
		cache.set(alice, {
			tools: [{ ...ECHO_TOOL, description: "a".repeat(300) }],
			discoveredAt: 1,
		});
		cache.set(bob, {
			tools: [{ ...ECHO_TOOL, name: "bob", description: "b".repeat(300) }],
			discoveredAt: 2,
		});

		expect(cache.get(alice)).toBeUndefined();
		expect(cache.get(bob)?.tools[0]?.name).toBe("bob");
		expect(cache.byteSize).toBeLessThanOrEqual(700);
	});
});
