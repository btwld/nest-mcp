import type { RequestMethod } from "@modelcontextprotocol/client";

import type { McpClientOperationInput } from "./types.ts";

/**
 * Runtime-owned proof that an operation returns the ordinary official result.
 * A method string alone is insufficient because custom-schema, manual-MRTR,
 * and managed-subscription APIs deliberately use different result contracts.
 */
const exactResultMethods = new WeakMap<McpClientOperationInput, RequestMethod>();

export function markExactMcpClientResult(
	input: McpClientOperationInput,
	method: RequestMethod,
): void {
	if (input.method !== method) {
		throw new TypeError("The exact client result profile must match the operation method.");
	}
	exactResultMethods.set(input, method);
}

export function hasExactMcpClientResult(
	input: McpClientOperationInput,
	method: RequestMethod,
): boolean {
	return exactResultMethods.get(input) === method;
}
