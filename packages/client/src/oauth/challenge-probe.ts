import type { FetchLike } from "@modelcontextprotocol/client";
import { McpClientOAuthBootstrapError, McpClientOAuthBootstrapErrorCode } from "./bootstrap.ts";

export interface McpClientOAuthChallengeProbeInput {
	readonly serverUrl: string;
	/** Already admitted, unauthenticated fetch. The host owns DNS/redirect/response limits and lease cleanup. */
	readonly fetch: FetchLike;
	/** Host deadline and cancellation. Fetch must honor it; this helper owns no transport. */
	readonly signal: AbortSignal;
}

/** One non-credentialed GET. Pass its bounded raw header to bootstrap.discover({ wwwAuthenticate }). */
export async function probeMcpClientOAuthChallenge(
	input: McpClientOAuthChallengeProbeInput,
): Promise<string | undefined> {
	const { fetch, signal, serverUrl } = input;
	if (typeof fetch !== "function" || typeof serverUrl !== "string" || serverUrl.length > 4_096)
		throw invalidOptions();
	let endpoint: URL;
	try {
		endpoint = new URL(serverUrl);
	} catch {
		throw invalidOptions();
	}
	if (
		(endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.hash !== ""
	)
		throw invalidOptions();
	signal.throwIfAborted();
	let response: Response;
	try {
		response = await fetch(serverUrl, {
			cache: "no-store",
			credentials: "omit",
			headers: { Accept: "text/event-stream", "Cache-Control": "no-store" },
			method: "GET",
			redirect: "error",
			signal,
		});
	} catch {
		signal.throwIfAborted();
		throw new McpClientOAuthBootstrapError(McpClientOAuthBootstrapErrorCode.DiscoveryFailed);
	}
	try {
		signal.throwIfAborted();
		const challenge =
			response.status === 401 ? (response.headers.get("www-authenticate") ?? undefined) : undefined;
		if (challenge !== undefined && challenge.length > 8_192) throw invalidOptions();
		return challenge;
	} finally {
		try {
			await response.body?.cancel();
		} catch {
			/* The host still closes the admitted fetch lease. */
		}
	}
}

function invalidOptions(): McpClientOAuthBootstrapError {
	return new McpClientOAuthBootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
}
