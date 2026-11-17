import { setTimeout as delay } from "node:timers/promises";

import { completable, McpServerRuntime, ResourceTemplate } from "@nest-mcp/server";
import type { McpServerFeature } from "@nest-mcp/server";
import { z } from "zod/v4";

/**
 * The everything server the official `@modelcontextprotocol/conformance` suite
 * is pointed at.
 *
 * Every `test_*` name below is dictated by a suite scenario: the CLI prints the
 * exact tool, resource, and prompt contract it expects when a scenario fails.
 * Names outside that contract are prefixed `nest_mcp_` and exist to cover
 * `@nest-mcp/server` surface no active scenario reaches yet — currently
 * structured tool output.
 */

/** A 1x1 transparent PNG — the smallest payload that is still a real image. */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A 45-byte 8-bit mono PCM WAV holding a single silent sample. */
const WAV_BASE64 = "UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";

const NOTIFICATION_STEP_MS = 50;

const COMPLETION_VALUES = ["paris", "park", "party", "parliament"];

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

function elicitationSummary(result: { action: string; content?: unknown }): string {
	return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`;
}

/** Builds the everything-server runtime the conformance suite is pointed at. */
export function createEverythingRuntime(): McpServerRuntime {
	return new McpServerRuntime({
		name: "conformance-everything",
		serverInfo: {
			name: "nest-mcp-everything-server",
			title: "Nest MCP everything server",
			version: "0.0.0",
		},
		serverOptions: {
			capabilities: { logging: {} },
			instructions:
				"Everything server fixture for the official MCP conformance suite: tools, structured output, resources, resource templates, prompts, completions, logging, progress, sampling, and elicitation.",
		},
		features: [toolsFeature, resourcesFeature, promptsFeature],
	});
}
