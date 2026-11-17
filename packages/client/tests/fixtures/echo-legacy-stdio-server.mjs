import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

const server = new McpServer({
	name: "mcp-client-legacy-stdio-echo-fixture",
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

await server.connect(new StdioServerTransport());

let closing = false;
async function closeServer() {
	if (closing) return;
	closing = true;
	try {
		await server.close();
	} catch (error) {
		process.exitCode = 1;
		process.stderr.write(`Failed to close legacy stdio echo server: ${String(error)}\n`);
	}
}

process.stdin.once("end", () => void closeServer());
process.once("SIGINT", () => void closeServer());
process.once("SIGTERM", () => void closeServer());
