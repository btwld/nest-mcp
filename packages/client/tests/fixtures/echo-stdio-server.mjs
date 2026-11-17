import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

function createEchoServer() {
	const server = new McpServer({
		name: "mcp-client-stdio-echo-fixture",
		version: "1.0.0",
	});

	server.registerTool(
		"echo",
		{
			description: "Echoes the provided text.",
			inputSchema: z.object({ text: z.string() }),
		},
		({ text }) => ({
			content: [{ type: "text", text }],
		}),
	);

	return server;
}

const handle = serveStdio(createEchoServer);

async function closeServer() {
	try {
		await handle.close();
	} catch (error) {
		process.exitCode = 1;
		process.stderr.write(`Failed to close stdio echo server: ${String(error)}\n`);
	}
}

process.stdin.once("end", () => void closeServer());
process.once("SIGINT", () => void closeServer());
process.once("SIGTERM", () => void closeServer());
