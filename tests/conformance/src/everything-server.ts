import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
	CLIENT_CAPABILITIES_META_KEY,
	ProtocolError,
	ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type { InputRequests } from "@modelcontextprotocol/server";
import {
	acceptedContent,
	completable,
	createRequestStateCodec,
	fromJsonSchema,
	inputRequired,
	McpServerRuntime,
	ResourceTemplate,
} from "@nest-mcp/server";
import type { McpServerFeature, ServerNotifier } from "@nest-mcp/server";
import { z } from "zod/v4";

/**
 * The everything server the official `@modelcontextprotocol/conformance` suite
 * is pointed at.
 *
 * Every `test_*` name below, and `json_schema_2020_12_tool`, is dictated by a
 * suite scenario: the CLI prints the exact tool, resource, and prompt contract
 * it expects when a scenario fails. Names outside that contract are prefixed
 * `nest_mcp_` and exist to cover `@nest-mcp/server` surface no active scenario
 * reaches yet — currently structured tool output.
 */

/** A 1x1 transparent PNG — the smallest payload that is still a real image. */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A 45-byte 8-bit mono PCM WAV holding a single silent sample. */
const WAV_BASE64 = "UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";

const NOTIFICATION_STEP_MS = 50;

const COMPLETION_VALUES = ["paris", "park", "party", "parliament"];

/**
 * `requestState` round-trips through the client and comes back as
 * attacker-controlled input, so it is HMAC-sealed when minted and verified at
 * the server seam before any handler runs. The key is process-local: the
 * 2026-07-28 path serves every request from a fresh server instance, and the
 * state itself is the only thing that survives between rounds.
 */
const requestStateCodec = createRequestStateCodec<Record<string, unknown>>({
	key: randomBytes(32),
});

/** In-band elicitation asking for a single required `name` string. */
function nameRequest(message: string) {
	return inputRequired.elicit({
		message,
		requestedSchema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
	});
}

/** In-band elicitation asking for a single required `ok` boolean. */
function confirmRequest() {
	return inputRequired.elicit({
		message: "Please confirm",
		requestedSchema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of a sampling result carried back in `inputResponses`, when it has one. */
function samplingText(response: unknown): string | undefined {
	if (!isRecord(response)) return undefined;
	const content = response["content"];
	return isRecord(content) && typeof content["text"] === "string" ? content["text"] : undefined;
}

/** Roots of a `roots/list` result carried back in `inputResponses`, when present. */
function rootsOf(response: unknown): readonly unknown[] | undefined {
	if (!isRecord(response)) return undefined;
	const roots: unknown = response["roots"];
	return Array.isArray(roots) ? roots : undefined;
}

/** Tool contract required by the `tools-*` and `elicitation-*` scenarios. */
const toolsFeature: McpServerFeature = (server) => {
	server.registerTool(
		"test_simple_text",
		{
			title: "Simple text",
			description: "Returns a single text content block.",
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		() => ({ content: [{ type: "text", text: "This is a simple text response for testing." }] }),
	);

	server.registerTool(
		"test_image_content",
		{
			title: "Image content",
			description: "Returns a single image content block.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => ({ content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] }),
	);

	server.registerTool(
		"test_audio_content",
		{
			title: "Audio content",
			description: "Returns a single audio content block.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => ({ content: [{ type: "audio", data: WAV_BASE64, mimeType: "audio/wav" }] }),
	);

	server.registerTool(
		"test_embedded_resource",
		{
			title: "Embedded resource",
			description: "Returns an embedded resource content block.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => ({
			content: [
				{
					type: "resource",
					resource: {
						uri: "test://embedded-resource",
						mimeType: "text/plain",
						text: "This is an embedded resource content.",
					},
				},
			],
		}),
	);

	server.registerTool(
		"test_multiple_content_types",
		{
			title: "Mixed content",
			description: "Returns text, image, and embedded resource content blocks together.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => ({
			content: [
				{ type: "text", text: "Multiple content types test:" },
				{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
				{
					type: "resource",
					resource: {
						uri: "test://mixed-content-resource",
						mimeType: "application/json",
						text: JSON.stringify({ test: "data", value: 123 }),
					},
				},
			],
		}),
	);

	server.registerTool(
		"test_tool_with_logging",
		{
			title: "Tool with logging",
			description: "Emits three info-level log notifications while executing.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (context) => {
			await context.mcpReq.log("info", "Tool execution started");
			await delay(NOTIFICATION_STEP_MS);
			await context.mcpReq.log("info", "Tool processing data");
			await delay(NOTIFICATION_STEP_MS);
			await context.mcpReq.log("info", "Tool execution completed");
			return { content: [{ type: "text", text: "Tool with logging completed" }] };
		},
	);

	server.registerTool(
		"test_error_handling",
		{
			title: "Error handling",
			description: "Always reports a tool-level failure through the isError result channel.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => ({
			isError: true,
			content: [{ type: "text", text: "This tool intentionally returns an error for testing" }],
		}),
	);

	server.registerTool(
		"test_tool_with_progress",
		{
			title: "Tool with progress",
			description: "Emits 0/100, 50/100, and 100/100 progress notifications while executing.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (context) => {
			// Bracket access: `_meta` is the wire field name, not a private member.
			const progressToken = context.mcpReq["_meta"]?.progressToken;
			for (const progress of [0, 50, 100]) {
				if (progressToken !== undefined) {
					await context.mcpReq.notify({
						method: "notifications/progress",
						params: { progressToken, progress, total: 100 },
					});
				}
				if (progress !== 100) await delay(NOTIFICATION_STEP_MS);
			}
			return { content: [{ type: "text", text: "Tool with progress completed" }] };
		},
	);

	server.registerTool(
		"test_sampling",
		{
			title: "Sampling",
			description: "Asks the client to run an LLM completion through sampling/createMessage.",
			inputSchema: z.object({ prompt: z.string().describe("The prompt to send to the LLM.") }),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ prompt }, context) => {
			const result = await context.mcpReq.requestSampling({
				messages: [{ role: "user", content: { type: "text", text: prompt } }],
				maxTokens: 100,
			});
			return {
				content: [{ type: "text", text: `LLM response: ${JSON.stringify(result.content)}` }],
			};
		},
	);

	server.registerTool(
		"test_elicitation",
		{
			title: "Elicitation",
			description: "Asks the client for user input through elicitation/create.",
			inputSchema: z.object({ message: z.string().describe("The message to show the user.") }),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ message }, context) => {
			const result = await context.mcpReq.elicitInput({
				message,
				requestedSchema: {
					type: "object",
					properties: {
						username: { type: "string", description: "User's response" },
						email: { type: "string", description: "User's email address" },
					},
					required: ["username", "email"],
				},
			});
			return {
				content: [
					{
						type: "text",
						text: `User response: <action: ${result.action}, content: ${JSON.stringify(result.content ?? {})}>`,
					},
				],
			};
		},
	);

	server.registerTool(
		"test_elicitation_sep1034_defaults",
		{
			title: "Elicitation defaults (SEP-1034)",
			description: "Elicits a form whose every primitive field declares a default value.",
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (context) => {
			const result = await context.mcpReq.elicitInput({
				message: "Please confirm the pre-filled values.",
				requestedSchema: {
					type: "object",
					properties: {
						name: { type: "string", description: "Full name", default: "John Doe" },
						age: { type: "integer", description: "Age in years", default: 30 },
						score: { type: "number", description: "Score", default: 95.5 },
						status: {
							type: "string",
							description: "Account status",
							enum: ["active", "inactive", "pending"],
							default: "active",
						},
						verified: { type: "boolean", description: "Verified", default: true },
					},
				},
			});
			return { content: [{ type: "text", text: elicitationSummary(result) }] };
		},
	);

	server.registerTool(
		"test_elicitation_sep1330_enums",
		{
			title: "Elicitation enums (SEP-1330)",
			description: "Elicits a form covering all five SEP-1330 enum schema variants.",
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (context) => {
			const result = await context.mcpReq.elicitInput({
				message: "Please choose from every enum variant.",
				requestedSchema: {
					type: "object",
					properties: {
						untitledSingle: { type: "string", enum: ["option1", "option2", "option3"] },
						titledSingle: {
							type: "string",
							oneOf: [
								{ const: "value1", title: "First Option" },
								{ const: "value2", title: "Second Option" },
								{ const: "value3", title: "Third Option" },
							],
						},
						legacyTitled: {
							type: "string",
							enum: ["opt1", "opt2", "opt3"],
							enumNames: ["Option One", "Option Two", "Option Three"],
						},
						untitledMulti: {
							type: "array",
							items: { type: "string", enum: ["option1", "option2", "option3"] },
						},
						titledMulti: {
							type: "array",
							items: {
								anyOf: [
									{ const: "value1", title: "First Choice" },
									{ const: "value2", title: "Second Choice" },
									{ const: "value3", title: "Third Choice" },
								],
							},
						},
					},
				},
			});
			return { content: [{ type: "text", text: elicitationSummary(result) }] };
		},
	);

	// Beyond the suite contract: structured tool output is a first-class
	// @nest-mcp/server surface that no active scenario exercises yet.
	server.registerTool(
		"nest_mcp_structured_output",
		{
			title: "Structured output",
			description: "Returns structured content validated against an output schema.",
			inputSchema: z.object({ a: z.number(), b: z.number() }),
			outputSchema: z.object({ sum: z.number() }),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		({ a, b }) => {
			const structuredContent = { sum: a + b };
			return {
				content: [{ type: "text", text: JSON.stringify(structuredContent) }],
				structuredContent,
			};
		},
	);
};

/** Resource contract required by the `resources-*` scenarios. */
const resourcesFeature: McpServerFeature = (server) => {
	server.registerResource(
		"test_static_text",
		"test://static-text",
		{
			title: "Static text resource",
			description: "A static text resource.",
			mimeType: "text/plain",
		},
		(uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/plain",
					text: "This is the content of the static text resource.",
				},
			],
		}),
	);

	server.registerResource(
		"test_static_binary",
		"test://static-binary",
		{
			title: "Static binary resource",
			description: "A static binary resource served as base64 PNG.",
			mimeType: "image/png",
		},
		(uri) => ({
			contents: [{ uri: uri.href, mimeType: "image/png", blob: PNG_BASE64 }],
		}),
	);

	server.registerResource(
		"test_watched_resource",
		"test://watched-resource",
		{
			title: "Watched resource",
			description: "Subscription target for the resources-subscribe scenarios.",
			mimeType: "text/plain",
		},
		(uri) => ({
			contents: [{ uri: uri.href, mimeType: "text/plain", text: "Watched resource content." }],
		}),
	);

	server.registerResource(
		"test_template_data",
		new ResourceTemplate("test://template/{id}/data", {
			list: () => ({
				resources: [{ uri: "test://template/123/data", name: "123", mimeType: "application/json" }],
			}),
			complete: {
				id: (value) => ["123", "456", "789"].filter((id) => id.startsWith(value)),
			},
		}),
		{
			title: "Templated data resource",
			description: "Substitutes {id} and returns JSON describing the match.",
			mimeType: "application/json",
		},
		(uri, variables) => {
			const id = String(variables.id);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }),
					},
				],
			};
		},
	);
};

/** Prompt contract required by the `prompts-*` and `completion-complete` scenarios. */
const promptsFeature: McpServerFeature = (server) => {
	server.registerPrompt(
		"test_simple_prompt",
		{ title: "Simple prompt", description: "A prompt with no arguments." },
		() => ({
			messages: [
				{ role: "user", content: { type: "text", text: "This is a simple prompt for testing." } },
			],
		}),
	);

	server.registerPrompt(
		"test_prompt_with_arguments",
		{
			title: "Prompt with arguments",
			description: "A prompt that substitutes two required arguments.",
			argsSchema: z.object({
				arg1: completable(z.string().describe("First test argument"), (value) =>
					COMPLETION_VALUES.filter((entry) => entry.startsWith(value)),
				),
				arg2: z.string().describe("Second test argument"),
			}),
		},
		({ arg1, arg2 }) => ({
			messages: [
				{
					role: "user",
					content: { type: "text", text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'` },
				},
			],
		}),
	);

	server.registerPrompt(
		"test_prompt_with_embedded_resource",
		{
			title: "Prompt with embedded resource",
			description: "A prompt that embeds the resource named by its argument.",
			argsSchema: z.object({
				resourceUri: z.string().describe("URI of the resource to embed"),
			}),
		},
		({ resourceUri }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "resource",
						resource: {
							uri: resourceUri,
							mimeType: "text/plain",
							text: "Embedded resource content for testing.",
						},
					},
				},
				{
					role: "user",
					content: { type: "text", text: "Please process the embedded resource above." },
				},
			],
		}),
	);

	server.registerPrompt(
		"test_prompt_with_image",
		{ title: "Prompt with image", description: "A prompt whose first message is an image." },
		() => ({
			messages: [
				{ role: "user", content: { type: "image", data: PNG_BASE64, mimeType: "image/png" } },
				{ role: "user", content: { type: "text", text: "Please analyze the image above." } },
			],
		}),
	);
};

/**
 * Diagnostic tools the 2026-07-28 `server-stateless`, `json-schema-2020-12`,
 * and `http-custom-header-server-validation` scenarios call by name.
 */
const statelessDiagnosticsFeature: McpServerFeature = (server) => {
	// Typed loosely on purpose: `x-mcp-header` is an extension keyword, and the
	// annotation has to reach `tools/list` unchanged.
	const regionParameter: Record<string, unknown> = {
		type: "string",
		description: "Mirrored into the Mcp-Param-Region request header.",
		"x-mcp-header": "Region",
	};
	server.registerTool(
		"test_x_mcp_header",
		{
			title: "Mirrored header parameter",
			description: "Declares a parameter clients mirror into an Mcp-Param-* request header.",
			inputSchema: fromJsonSchema<{ region?: string; level?: number }>({
				type: "object",
				properties: {
					region: regionParameter,
					level: { type: "integer", description: "An argument that is not mirrored." },
				},
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(arguments_) => ({
			content: [{ type: "text", text: `region=${arguments_.region ?? "<none>"}` }],
		}),
	);

	// Needs the `sampling` client capability; the scenario declares none and
	// expects the server seam to refuse with -32021 over HTTP 400.
	server.registerTool(
		"test_missing_capability",
		{
			title: "Missing capability",
			description: "Requests sampling input the caller may not have declared support for.",
			inputSchema: z.object({}),
		},
		(_arguments, context) => {
			if (context.mcpReq.inputResponses?.["llm_answer"] === undefined) {
				return inputRequired({
					inputRequests: {
						llm_answer: inputRequired.createMessage({
							messages: [
								{
									role: "user",
									content: { type: "text", text: "Reply with the single word: pong" },
								},
							],
							maxTokens: 16,
						}),
					},
				});
			}
			return { content: [{ type: "text", text: "sampling round-trip complete" }] };
		},
	);

	// The check only asserts that the response stream carries no independent
	// top-level JSON-RPC request, so a plain successful call is the contract.
	server.registerTool(
		"test_streaming_elicitation",
		{
			title: "Streaming response",
			description: "Answers on a response stream that carries result frames only.",
			inputSchema: z.object({}),
		},
		() => ({
			content: [
				{ type: "text", text: "stream observed: result frames only, no top-level requests" },
			],
		}),
	);

	// Request-scoped logging is gated on the request's `_meta` log level; the
	// scenario omits it and asserts that no log notification is emitted.
	server.registerTool(
		"test_logging_tool",
		{
			title: "Request-scoped logging",
			description:
				"Logs through the request-scoped channel that honours the per-request log level.",
			inputSchema: z.object({}),
		},
		async (_arguments, context) => {
			await context.mcpReq.log("info", "test_logging_tool ran");
			return { content: [{ type: "text", text: "logged through the request-scoped channel" }] };
		},
	);

	server.registerTool(
		"json_schema_2020_12_tool",
		{
			title: "JSON Schema 2020-12",
			description: "Advertises an input schema that uses JSON Schema 2020-12 keywords.",
			inputSchema: fromJsonSchema({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				$defs: {
					address: {
						$anchor: "addressDef",
						type: "object",
						properties: { street: { type: "string" }, city: { type: "string" } },
					},
				},
				properties: {
					name: { type: "string" },
					address: { $ref: "#/$defs/address" },
					contactMethod: { type: "string", enum: ["phone", "email"] },
					phone: { type: "string" },
					email: { type: "string" },
				},
				allOf: [{ anyOf: [{ required: ["phone"] }, { required: ["email"] }] }],
				if: { properties: { contactMethod: { const: "phone" } }, required: ["contactMethod"] },
				// oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema keyword.
				then: { required: ["phone"] },
				else: { required: ["email"] },
				additionalProperties: false,
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(arguments_) => ({
			content: [
				{
					type: "text",
					text: `JSON Schema 2020-12 tool called with: ${JSON.stringify(arguments_)}`,
				},
			],
		}),
	);
};

/**
 * Multi-round input contract required by the `input-required-result-*`
 * scenarios. Every tool is written write-once: it answers with an
 * `input_required` result until the retried request carries what it needs.
 */
const inputRequiredFeature: McpServerFeature = (server) => {
	// Also driven by the result-type, missing-input-response, ignore-extra-params,
	// and validate-input scenarios: anything without an accepted `user_name`
	// answer is re-requested rather than rejected.
	server.registerTool(
		"test_input_required_result_elicitation",
		{
			title: "Multi-round elicitation",
			description: "Asks for the caller name through an in-band elicitation request.",
			inputSchema: z.object({}),
		},
		(_arguments, context) => {
			const name = acceptedContent<{ name: string }>(
				context.mcpReq.inputResponses,
				"user_name",
			)?.name;
			if (typeof name !== "string") {
				return inputRequired({ inputRequests: { user_name: nameRequest("What is your name?") } });
			}
			return { content: [{ type: "text", text: `Hello, ${name}!` }] };
		},
	);

	server.registerTool(
		"test_input_required_result_sampling",
		{
			title: "Multi-round sampling",
			description: "Asks for an LLM completion through an in-band sampling request.",
			inputSchema: z.object({}),
		},
		(_arguments, context) => {
			const response = context.mcpReq.inputResponses?.["capital_question"];
			if (response === undefined) {
				return inputRequired({
					inputRequests: {
						capital_question: inputRequired.createMessage({
							messages: [
								{ role: "user", content: { type: "text", text: "What is the capital of France?" } },
							],
							maxTokens: 100,
						}),
					},
				});
			}
			const text = samplingText(response) ?? JSON.stringify(response);
			return { content: [{ type: "text", text: `Sampling response: ${text}` }] };
		},
	);

	server.registerTool(
		"test_input_required_result_list_roots",
		{
			title: "Multi-round roots",
			description: "Asks for the client roots through an in-band roots/list request.",
			inputSchema: z.object({}),
		},
		(_arguments, context) => {
			const roots = rootsOf(context.mcpReq.inputResponses?.["client_roots"]);
			if (roots === undefined) {
				return inputRequired({ inputRequests: { client_roots: inputRequired.listRoots() } });
			}
			const uris = roots.map((root) => (isRecord(root) ? String(root["uri"]) : "")).join(", ");
			return {
				content: [
					{ type: "text", text: `Client exposed ${String(roots.length)} root(s): ${uris}` },
				],
			};
		},
	);

	server.registerTool(
		"test_input_required_result_request_state",
		{
			title: "Multi-round request state",
			description:
				"Round-trips integrity-protected request state alongside an elicitation request.",
			inputSchema: z.object({}),
		},
		async (_arguments, context) => {
			if (acceptedContent(context.mcpReq.inputResponses, "confirm") === undefined) {
				return inputRequired({
					inputRequests: { confirm: confirmRequest() },
					requestState: await requestStateCodec.mint({
						tool: "request_state",
						nonce: randomUUID(),
					}),
				});
			}
			// The seam-level verify hook has already proven integrity and decoded
			// the payload, so the accessor returns verified state or nothing.
			if (context.mcpReq.requestState<Record<string, unknown>>() === undefined) {
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					"Invalid requestState: missing or failed integrity verification",
				);
			}
			return {
				content: [
					{ type: "text", text: "state-ok: requestState verified and confirmation received" },
				],
			};
		},
	);

	server.registerTool(
		"test_input_required_result_multiple_inputs",
		{
			title: "Multi-round mixed inputs",
			description: "Asks for elicitation, sampling, and roots input in a single round.",
			inputSchema: z.object({}),
		},
		async (_arguments, context) => {
			const responses = context.mcpReq.inputResponses;
			const name = acceptedContent<{ name: string }>(responses, "user_name")?.name;
			const greeting = samplingText(responses?.["greeting"]);
			const roots = rootsOf(responses?.["client_roots"]);
			if (typeof name !== "string" || greeting === undefined || roots === undefined) {
				return inputRequired({
					inputRequests: {
						user_name: nameRequest("What is your name?"),
						greeting: inputRequired.createMessage({
							messages: [{ role: "user", content: { type: "text", text: "Generate a greeting" } }],
							maxTokens: 50,
						}),
						client_roots: inputRequired.listRoots(),
					},
					requestState: await requestStateCodec.mint({
						tool: "multiple_inputs",
						nonce: randomUUID(),
					}),
				});
			}
			return {
				content: [
					{ type: "text", text: `${greeting} ${name} — ${String(roots.length)} root(s) visible` },
				],
			};
		},
	);

	// The round number lives in the integrity-protected state, since the
	// 2026-07-28 path keeps nothing per connection, and it changes every round.
	server.registerTool(
		"test_input_required_result_multi_round",
		{
			title: "Multi-round sequence",
			description: "Runs two elicitation rounds with evolving request state before completing.",
			inputSchema: z.object({}),
		},
		async (_arguments, context) => {
			const state = context.mcpReq.requestState<Record<string, unknown>>();
			const round =
				state?.["tool"] === "multi_round" && typeof state["round"] === "number"
					? state["round"]
					: 0;
			if (round === 0) {
				return inputRequired({
					inputRequests: { step1: nameRequest("Step 1: What is your name?") },
					requestState: await requestStateCodec.mint({
						tool: "multi_round",
						round: 1,
						nonce: randomUUID(),
					}),
				});
			}
			if (round === 1) {
				const name =
					acceptedContent<{ name: string }>(context.mcpReq.inputResponses, "step1")?.name ??
					"unknown";
				return inputRequired({
					inputRequests: {
						step2: inputRequired.elicit({
							message: "Step 2: What is your favorite color?",
							requestedSchema: {
								type: "object",
								properties: { color: { type: "string" } },
								required: ["color"],
							},
						}),
					},
					requestState: await requestStateCodec.mint({
						tool: "multi_round",
						round: 2,
						name,
						nonce: randomUUID(),
					}),
				});
			}
			const color =
				acceptedContent<{ color: string }>(context.mcpReq.inputResponses, "step2")?.color ??
				"unknown";
			const name = typeof state?.["name"] === "string" ? state["name"] : "unknown";
			return { content: [{ type: "text", text: `Multi-round complete: ${name} likes ${color}` }] };
		},
	);

	// A retry whose state fails verification is refused at the server seam with
	// -32602 before this handler runs, so the handler only ever sees verified state.
	server.registerTool(
		"test_input_required_result_tampered_state",
		{
			title: "Multi-round tamper check",
			description: "Completes only when the retried request state passes integrity verification.",
			inputSchema: z.object({}),
		},
		async (_arguments, context) => {
			if (
				context.mcpReq.requestState() !== undefined &&
				acceptedContent(context.mcpReq.inputResponses, "confirm") !== undefined
			) {
				return { content: [{ type: "text", text: "integrity-ok: requestState verified" }] };
			}
			return inputRequired({
				inputRequests: { confirm: confirmRequest() },
				requestState: await requestStateCodec.mint({ tool: "tampered_state", nonce: randomUUID() }),
			});
		},
	);

	// Only asks for input kinds the request's declared client capabilities cover.
	server.registerTool(
		"test_input_required_result_capabilities",
		{
			title: "Multi-round capability check",
			description: "Requests only the input kinds the caller declared support for.",
			inputSchema: z.object({}),
		},
		(_arguments, context) => {
			if (context.mcpReq.inputResponses !== undefined) {
				return { content: [{ type: "text", text: "Capability-aware input requests fulfilled" }] };
			}
			// Read as plain records: the scenario states capabilities in the wire
			// vocabulary, including entries the current revision marks as deprecated.
			const envelope: Record<string, unknown> = context.mcpReq.envelope ?? {};
			const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
			const declared = isRecord(capabilities) ? capabilities : {};
			const inputRequests: InputRequests = {};
			if (declared["elicitation"] !== undefined) {
				inputRequests["user_name"] = nameRequest("What is your name?");
			}
			if (declared["sampling"] !== undefined) {
				inputRequests["greeting"] = inputRequired.createMessage({
					messages: [
						{ role: "user", content: { type: "text", text: "Generate a short greeting" } },
					],
					maxTokens: 50,
				});
			}
			if (declared["roots"] !== undefined) {
				inputRequests["client_roots"] = inputRequired.listRoots();
			}
			if (Object.keys(inputRequests).length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No declared client capability supports an in-band input request",
						},
					],
				};
			}
			return inputRequired({ inputRequests });
		},
	);

	// `prompts/get` shares the multi-round result vocabulary with `tools/call`.
	server.registerPrompt(
		"test_input_required_result_prompt",
		{
			title: "Multi-round prompt",
			description: "A prompt that requires elicitation input before it renders.",
		},
		(context) => {
			const promptContext = acceptedContent<{ context: string }>(
				context.mcpReq.inputResponses,
				"user_context",
			)?.context;
			if (typeof promptContext !== "string") {
				return inputRequired({
					inputRequests: {
						user_context: inputRequired.elicit({
							message: "What context should the prompt use?",
							requestedSchema: {
								type: "object",
								properties: { context: { type: "string" } },
								required: ["context"],
							},
						}),
					},
				});
			}
			return {
				messages: [
					{
						role: "user",
						content: { type: "text", text: `Use the following context: ${promptContext}` },
					},
				],
			};
		},
	);
};

/**
 * Triggers the `server-stateless` scenario calls while a `subscriptions/listen`
 * stream is open. Each call is served by a fresh server instance, so there is
 * no list to mutate: publishing the change event is what the requirement measures.
 */
function listChangeTriggersFeature(notifier: () => ServerNotifier): McpServerFeature {
	return (server) => {
		server.registerTool(
			"test_trigger_tool_change",
			{
				title: "Trigger tool list change",
				description: "Publishes a tool list-changed event to open subscription streams.",
				inputSchema: z.object({}),
			},
			() => {
				notifier().toolsChanged();
				return { content: [{ type: "text", text: "tools_list_changed published" }] };
			},
		);

		server.registerTool(
			"test_trigger_prompt_change",
			{
				title: "Trigger prompt list change",
				description: "Publishes a prompt list-changed event to open subscription streams.",
				inputSchema: z.object({}),
			},
			() => {
				notifier().promptsChanged();
				return { content: [{ type: "text", text: "prompts_list_changed published" }] };
			},
		);
	};
}

function elicitationSummary(result: { action: string; content?: unknown }): string {
	return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`;
}

/** Builds the everything-server runtime the conformance suite is pointed at. */
export function createEverythingRuntime(): McpServerRuntime {
	const runtime: McpServerRuntime = new McpServerRuntime({
		name: "conformance-everything",
		serverInfo: {
			name: "nest-mcp-everything-server",
			title: "Nest MCP everything server",
			version: "0.0.0",
		},
		serverOptions: {
			capabilities: { logging: {} },
			instructions:
				"Everything server fixture for the official MCP conformance suite: tools, structured output, resources, resource templates, prompts, completions, logging, progress, sampling, elicitation, and multi-round input.",
			// Every retried request that carries state is verified before its handler runs.
			requestState: { verify: (state, context) => requestStateCodec.verify(state, context) },
		},
		features: [
			toolsFeature,
			statelessDiagnosticsFeature,
			inputRequiredFeature,
			listChangeTriggersFeature(() => runtime.notify),
			resourcesFeature,
			promptsFeature,
		],
	});
	return runtime;
}
