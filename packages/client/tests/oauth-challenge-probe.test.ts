import { describe, expect, it, vi } from "vitest";
import { probeMcpClientOAuthChallenge } from "../src/oauth/challenge-probe.ts";
import { McpClientOAuthBootstrapErrorCode } from "../src/oauth/bootstrap.ts";

const serverUrl = "https://tools.example.test/mcp";
describe("admitted OAuth challenge probing", () => {
	it("makes one credential-free GET and cancels a streaming response before returning its raw challenge", async () => {
		const cancel = vi.fn();
		const header = 'Bearer scope="calendar.read"';
		const fetch = vi.fn(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					status: 401,
					headers: { "WWW-Authenticate": header },
				}),
		);
		const signal = new AbortController().signal;
		expect(await probeMcpClientOAuthChallenge({ serverUrl, fetch, signal })).toBe(header);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(serverUrl, {
			cache: "no-store",
			credentials: "omit",
			method: "GET",
			redirect: "error",
			signal,
			headers: { Accept: "text/event-stream", "Cache-Control": "no-store" },
		});
		expect(cancel).toHaveBeenCalledOnce();
	});
	it.each([200, 403, 405])(
		"allows well-known discovery after a %i without consuming the body",
		async (status) => {
			const cancel = vi.fn();
			expect(
				await probeMcpClientOAuthChallenge({
					serverUrl,
					signal: new AbortController().signal,
					fetch: async () =>
						new Response(new ReadableStream({ cancel }), {
							status,
							headers: { "WWW-Authenticate": "Bearer" },
						}),
				}),
			).toBeUndefined();
			expect(cancel).toHaveBeenCalledOnce();
		},
	);
	it("rejects oversized headers and still cancels the response", async () => {
		const cancel = vi.fn();
		await expect(
			probeMcpClientOAuthChallenge({
				serverUrl,
				signal: new AbortController().signal,
				fetch: async () =>
					new Response(new ReadableStream({ cancel }), {
						status: 401,
						headers: { "WWW-Authenticate": "x".repeat(8_193) },
					}),
			}),
		).rejects.toMatchObject({ code: McpClientOAuthBootstrapErrorCode.InvalidOptions });
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("preserves caller cancellation and sends no request when already aborted", async () => {
		const fetch = vi.fn();
		const reason = new Error("cancelled");
		await expect(
			probeMcpClientOAuthChallenge({ serverUrl, fetch, signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("contains network failures without provider details or retries", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("provider-secret");
		});
		await expect(
			probeMcpClientOAuthChallenge({ serverUrl, fetch, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: McpClientOAuthBootstrapErrorCode.DiscoveryFailed });
		expect(fetch).toHaveBeenCalledOnce();
	});
});
