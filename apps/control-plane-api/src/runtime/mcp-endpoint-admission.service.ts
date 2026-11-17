import { Inject, Injectable } from "@nestjs/common";
import type { FetchLike } from "@modelcontextprotocol/client";
import {
	isLoopbackAddress,
	McpDocumentFetchError,
	normalizeGuardedHost,
	type McpDocumentFetchFailure,
} from "@nest-mcp/auth/cimd";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { MCP_CONTROL_PLANE_GUARDED_FETCH, type McpGuardedTransportFetch } from "./runtime.types.ts";

export interface AdmittedHttpEndpoint {
	readonly url: string;
	readonly host: string;
}

/**
 * Application policy over the guarded transport: which hosts this deployment
 * accepts, which URL shapes may be stored, and how a rejection maps onto the
 * control-plane error taxonomy. Address-level defence — DNS pinning, private
 * ranges, redirects, and body/SSE caps — belongs to the injected guarded fetch.
 */
@Injectable()
export class McpEndpointAdmissionService {
	readonly #allowedHosts: ReadonlySet<string>;

	constructor(
		@Inject(ControlPlaneConfigService) private readonly config: ControlPlaneConfigService,
		@Inject(MCP_CONTROL_PLANE_GUARDED_FETCH)
		private readonly guardedFetch: McpGuardedTransportFetch,
	) {
		this.#allowedHosts = new Set(config.allowedHosts.map(normalizeGuardedHost));
	}

	admit(rawEndpoint: string): AdmittedHttpEndpoint {
		let endpoint: URL;
		try {
			endpoint = new URL(rawEndpoint);
		} catch (cause) {
			throw endpointRejectedError(cause);
		}
		this.#assertAllowed(endpoint);
		return Object.freeze({ url: endpoint.href, host: endpoint.host });
	}

	createFetch(admittedEndpoint: string): FetchLike {
		const admittedOrigin = new URL(admittedEndpoint).origin;
		return async (url, init) => {
			const requested = requestUrl(url);
			if (requested.origin !== admittedOrigin) throw endpointRejectedError();
			try {
				return await this.guardedFetch(requested, init);
			} catch (cause) {
				if (cause instanceof McpDocumentFetchError && ADMISSION_FAILURES.has(cause.reason)) {
					throw endpointRejectedError(cause);
				}
				throw cause;
			}
		};
	}

	#assertAllowed(endpoint: URL): void {
		if (
			endpoint.username.length > 0 ||
			endpoint.password.length > 0 ||
			endpoint.search.length > 0 ||
			endpoint.hash.length > 0
		) {
			throw endpointRejectedError();
		}
		const hostname = normalizeGuardedHost(endpoint.hostname);
		if (!this.#allowedHosts.has(hostname)) throw endpointRejectedError();
		if (endpoint.protocol === "https:") return;
		if (
			endpoint.protocol === "http:" &&
			this.config.allowLoopbackHttp &&
			isLoopbackHostname(hostname)
		) {
			return;
		}
		throw endpointRejectedError();
	}
}

/**
 * Guard failures this host reports as its own admission rejection. Transport
 * faults (`network`, `timeout`, `too-large`) stay upstream failures, so a byte
 * fence or a dropped socket is never reported as a rejected endpoint.
 */
const ADMISSION_FAILURES: ReadonlySet<McpDocumentFetchFailure> = new Set<McpDocumentFetchFailure>([
	"blocked-address",
	"host-not-allowed",
	"insecure-url",
]);

function requestUrl(url: string | URL): URL {
	return url instanceof URL ? url : new URL(url);
}

/**
 * Name-level dev policy. `isLoopbackAddress` judges literals; `localhost` is a
 * name this deployment additionally treats as loopback, and the guarded fetch
 * still refuses it at connect time unless every resolved address is loopback.
 */
function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || isLoopbackAddress(hostname);
}

function endpointRejectedError(cause?: unknown): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_ENDPOINT_REJECTED",
		422,
		"The MCP endpoint is not admitted by this control plane.",
		cause === undefined ? undefined : { cause },
	);
}
