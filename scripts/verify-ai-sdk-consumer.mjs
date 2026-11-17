import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "mcp-ai-consumer-"));
try {
	const packed = {};
	for (const name of ["client", "core", "conformance"]) {
		const { version } = JSON.parse(await readFile(`packages/${name}/package.json`, "utf8"));
		execFileSync(
			"pnpm",
			["--filter", `@nest-mcp/${name}`, "pack", "--pack-destination", directory],
			{
				stdio: "inherit",
			},
		);
		packed[`@nest-mcp/${name}`] = `file:./nest-mcp-${name}-${version}.tgz`;
	}
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: packed,
		}),
	);
	await writeFile(
		join(directory, "pnpm-workspace.yaml"),
		JSON.stringify({ packages: ["."], overrides: packed }),
	);
	execFileSync("pnpm", ["install", "--ignore-scripts"], {
		cwd: directory,
		stdio: "inherit",
	});
	const core = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			'import "@nest-mcp/client"; try { import.meta.resolve("ai"); process.exit(1); } catch { console.log("optional peer absent"); }',
		],
		{ cwd: directory, encoding: "utf8" },
	);
	assert.match(core, /optional peer absent/);
	execFileSync("pnpm", ["add", "ai@7.0.83", "typescript@7.0.2", "--ignore-scripts"], {
		cwd: directory,
		stdio: "inherit",
	});
	await writeFile(
		join(directory, "consumer.ts"),
		`
 import { createAiSdkMcpTools, type AiSdkMcpToolDescriptor } from "@nest-mcp/client/ai-sdk";
 const descriptors: readonly AiSdkMcpToolDescriptor[] = [{ name: "inventory_lookup", inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } }];
 const controller = new AbortController();
 const input = { sku: "book" };
 let calls = 0;
 const tools = createAiSdkMcpTools(descriptors, (name, payload, signal) => {
   if (name !== "inventory_lookup" || payload !== input || signal !== controller.signal) throw new Error("Invocation changed");
   calls++; return { quantity: 2 };
 });
 const result = await tools.inventory_lookup!.execute!(input, { toolCallId: "call", context: {}, messages: [], abortSignal: controller.signal });
 if (calls !== 1 || JSON.stringify(result) !== '{"quantity":2}') throw new Error("Delegate not preserved");
 controller.abort();
 try { await tools.inventory_lookup!.execute!(input, { toolCallId: "call", context: {}, messages: [], abortSignal: controller.signal }); throw new Error("Cancellation lost"); } catch (error) { if (!(error instanceof DOMException)) throw error; }
 if (calls !== 1) throw new Error("Cancelled execution invoked");
 `,
	);
	execFileSync(
		"pnpm",
		[
			"exec",
			"tsc",
			"--strict",
			"--skipLibCheck",
			"--target",
			"ES2022",
			"--module",
			"NodeNext",
			"consumer.ts",
		],
		{ cwd: directory, stdio: "inherit" },
	);
	execFileSync(process.execPath, ["consumer.js"], { cwd: directory, stdio: "inherit" });
	console.log("Packed MCP AI adapter preserves protected delegation; core does not require AI.");
} finally {
	await rm(directory, { recursive: true, force: true });
}
