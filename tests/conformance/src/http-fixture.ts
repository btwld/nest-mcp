import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { NodeIncomingMessageLike, NodeServerResponseLike } from "@modelcontextprotocol/node";

import { createEverythingRuntime } from "./everything-server.ts";

/** Endpoint path the conformance CLI is pointed at. */
export const MCP_ENDPOINT_PATH = "/mcp";

export interface EverythingServerHandle {
	/** Absolute MCP endpoint URL, including the ephemeral port. */
	readonly url: string;
	close(): Promise<void>;
}

/**
 * Serves the everything-server fixture over plain `node:http` on loopback.
 *
 * Port `0` asks the kernel for an ephemeral port so parallel runs never collide;
 * the resolved URL is reported back through the returned handle.
 */
export async function startEverythingServer(port = 0): Promise<EverythingServerHandle> {
	const runtime = createEverythingRuntime();
	const handler = runtime.toNodeHandler();
	const server = createServer((request, response) => {
		if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== MCP_ENDPOINT_PATH) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("Not found");
			return;
		}
		void handler(toIncomingMessageLike(request), toServerResponseLike(response)).catch(
			(error: unknown) => {
				response.destroy(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});

	server.listen(port, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		await closeServer(server);
		await runtime.close();
		throw new TypeError("The conformance fixture did not bind a TCP address.");
	}

	return {
		url: `http://127.0.0.1:${String(address.port)}${MCP_ENDPOINT_PATH}`,
		close: async () => {
			await closeServer(server);
			await runtime.close();
		},
	};
}

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	server.close();
	await once(server, "close");
}

function toIncomingMessageLike(request: IncomingMessage): NodeIncomingMessageLike {
	return {
		...(request.method === undefined ? {} : { method: request.method }),
		...(request.url === undefined ? {} : { url: request.url }),
		headers: request.headers,
		[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
	};
}

function toServerResponseLike(response: ServerResponse): NodeServerResponseLike {
	return {
		writeHead: (statusCode, headers) => response.writeHead(statusCode, headers),
		write: (chunk) => response.write(chunk),
		end: (chunk) => response.end(chunk),
		on: (event, listener) =>
			response.on(event, (...arguments_: unknown[]) => listener(...arguments_)),
		destroyed: response.destroyed,
	};
}
