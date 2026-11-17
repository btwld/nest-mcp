import { Injectable, type INestApplication, type Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client, InMemoryTransport, specTypeSchemas } from "@modelcontextprotocol/client";
import {
	InMemoryServerEventBus,
	fromJsonSchema,
	inputRequired,
	type CallToolResult,
	type ElicitRequestFormParams,
	type InputRequiredResult,
	type JsonSchemaType,
	type JsonSchemaValidator,
	type McpServer,
	type ServerContext,
	type ServerEvent,
	type ServerEventBus,
	type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { McpServerRuntime } from "@nest-mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	McpModule,
	McpRuntimeService,
	Tool,
	type McpNestServerDefinition,
	type McpRequestStateVerifier,
} from "../src/index.ts";

const EMPTY_INPUT_SCHEMA = fromJsonSchema<Record<string, never>>({
	type: "object",
	properties: {},
	additionalProperties: false,
});

const ELICITATION_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
	type: "object",
	properties: { choice: { type: "string" } },
	required: ["choice"],
	additionalProperties: false,
};

@Injectable()
class ValidatorServerTools {
	@Tool({
		name: "validate-elicitation",
		servers: "validator-server",
		inputSchema: EMPTY_INPUT_SCHEMA,
	})
	async validateElicitation(
		_arguments: Record<string, never>,
		context: ServerContext,
	): Promise<CallToolResult> {
		const result = await context.mcpReq.elicitInput({
			message: "Choose a value",
			requestedSchema: ELICITATION_SCHEMA,
		});
		const choice =
			result.action === "accept" && typeof result.content?.["choice"] === "string"
				? result.content["choice"]
				: "none";
		return { content: [{ type: "text", text: choice }] };
	}
}

@Injectable()
class VerifierServerTools {
	@Tool({
		name: "read-request-state",
		servers: "verifier-server",
		inputSchema: EMPTY_INPUT_SCHEMA,
	})
	readRequestState(
		_arguments: Record<string, never>,
		context: ServerContext,
	): CallToolResult | InputRequiredResult {
		const state = context.mcpReq.requestState<{ readonly verified: string }>();
		if (state !== undefined) {
			return { content: [{ type: "text", text: `verified:${state.verified}` }] };
		}
		return inputRequired({ requestState: "sealed-request-state" });
	}
}

@Injectable()
class RecordingJsonSchemaValidator implements jsonSchemaValidator {
	readonly schemas: JsonSchemaType[] = [];
	readonly #delegate = new AjvJsonSchemaValidator();

	getValidator<Value>(schema: JsonSchemaType): JsonSchemaValidator<Value> {
		this.schemas.push(schema);
		return this.#delegate.getValidator<Value>(schema);
	}
}

@Injectable()
class RecordingRequestStateVerifier implements McpRequestStateVerifier {
	readonly calls: Array<{ readonly state: string; readonly method: string }> = [];

	verify(state: string, context: ServerContext): { readonly verified: string } {
		this.calls.push({ state, method: context.mcpReq.method });
		return { verified: state };
	}
}

@Injectable()
class RecordingServerEventBus implements ServerEventBus {
	readonly events: ServerEvent[] = [];
	readonly #delegate = new InMemoryServerEventBus();

	publish(event: ServerEvent): void {
		this.events.push(event);
		this.#delegate.publish(event);
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		return this.#delegate.subscribe(listener);
	}
}

type NestedServerCollaboratorSeam = "eventBus" | "jsonSchemaValidator" | "requestStateVerifier";

const COLLABORATOR_SEAMS = [
	{
		label: "serverOptions.jsonSchemaValidator",
		seam: "jsonSchemaValidator",
		requiredMethods: ["getValidator"],
	},
	{
		label: "serverOptions.requestState.verifier",
		seam: "requestStateVerifier",
		requiredMethods: ["verify"],
	},
	{
		label: "http.eventBus",
		seam: "eventBus",
		requiredMethods: ["publish", "subscribe"],
	},
] as const satisfies readonly {
	readonly label: string;
	readonly seam: NestedServerCollaboratorSeam;
	readonly requiredMethods: readonly string[];
}[];

describe("McpModule nested server collaborators", () => {
	let application: INestApplication | undefined;

	afterEach(async () => {
		await application?.close();
		application = undefined;
		vi.restoreAllMocks();
	});

	it("uses the injected JSON Schema validator for legacy elicitation responses", async () => {
		application = await createApplication(
			{
				collaborators: { providers: [RecordingJsonSchemaValidator] },
				servers: [
					{
						name: "validator-server",
						serverInfo: { name: "validator-server", version: "1.0.0" },
						serverOptions: { jsonSchemaValidator: RecordingJsonSchemaValidator },
					},
				],
			},
			[ValidatorServerTools],
		);
		const runtime = application.get(McpRuntimeService).server("validator-server");
		const validator = application.get(RecordingJsonSchemaValidator);
		const client = new Client(
			{ name: "validator-test", version: "1.0.0" },
			{
				capabilities: { elicitation: { form: {} } },
				versionNegotiation: { mode: "legacy" },
			},
		);
		client.setRequestHandler("elicitation/create", async () => ({
			action: "accept",
			content: { choice: "injected-validator" },
		}));
		const session = await connectFreshBuild(runtime, client, "legacy");

		try {
			await expect(
				client.callTool({ name: "validate-elicitation", arguments: {} }),
			).resolves.toMatchObject({
				content: [{ type: "text", text: "injected-validator" }],
			});
			expect(validator.schemas).toEqual([ELICITATION_SCHEMA]);
		} finally {
			await session.close();
		}
	});

	it("binds the injected request-state verifier and exposes its decoded value", async () => {
		application = await createApplication(
			{
				collaborators: { providers: [RecordingRequestStateVerifier] },
				servers: [
					{
						name: "verifier-server",
						serverInfo: { name: "verifier-server", version: "1.0.0" },
						serverOptions: {
							requestState: { verifier: RecordingRequestStateVerifier },
						},
					},
				],
			},
			[VerifierServerTools],
		);
		const runtime = application.get(McpRuntimeService).server("verifier-server");
		const verifier = application.get(RecordingRequestStateVerifier);
		const client = new Client(
			{ name: "verifier-test", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		const session = await connectFreshBuild(runtime, client, "modern");

		try {
			const originalRequest = {
				method: "tools/call",
				params: { name: "read-request-state", arguments: {} },
			} as const;
			await expect(
				client.request(originalRequest, specTypeSchemas.CallToolResult),
			).resolves.toMatchObject({
				content: [{ type: "text", text: "verified:sealed-request-state" }],
			});
			expect(verifier.calls).toEqual([{ state: "sealed-request-state", method: "tools/call" }]);
		} finally {
			await session.close();
		}
	});

	it("uses the injected event bus for runtime notifications", async () => {
		application = await createApplication({
			collaborators: { providers: [RecordingServerEventBus] },
			servers: [
				{
					name: "event-bus-server",
					serverInfo: { name: "event-bus-server", version: "1.0.0" },
					http: { eventBus: RecordingServerEventBus },
				},
			],
		});
		const runtime = application.get(McpRuntimeService).server("event-bus-server");
		const eventBus = application.get(RecordingServerEventBus);
		const listener = vi.fn();
		const unsubscribe = eventBus.subscribe(listener);

		expect(runtime.bus).toBe(eventBus);
		runtime.notify.toolsChanged();

		expect(eventBus.events).toEqual([{ kind: "tools_list_changed" }]);
		expect(listener).toHaveBeenCalledWith({ kind: "tools_list_changed" });
		unsubscribe();
	});

	it("does not forward raw lower-runtime HTTP callbacks supplied through untyped input", async () => {
		const rawBus = new RecordingServerEventBus();
		const rawOnError = vi.fn();
		const rawHttp: NonNullable<McpNestServerDefinition["http"]> = {};
		Reflect.set(rawHttp, "bus", rawBus);
		Reflect.set(rawHttp, "onerror", rawOnError);
		application = await createApplication({
			servers: [
				{
					name: "raw-http-options",
					serverInfo: { name: "raw-http-options", version: "1.0.0" },
					http: rawHttp,
				},
			],
		});
		const runtime = application.get(McpRuntimeService).server("raw-http-options");

		expect(runtime.bus).not.toBe(rawBus);
		runtime.notify.toolsChanged();
		expect(rawBus.events).toEqual([]);
		expect(rawOnError).not.toHaveBeenCalled();
	});

	it.each(COLLABORATOR_SEAMS)(
		"fails bootstrap when $label references an unregistered provider",
		async ({ seam }) => {
			const token = Symbol(`MISSING_${seam}`);
			const testingModule = await Test.createTestingModule({
				imports: [McpModule.forRoot({ servers: [serverDefinitionForSeam(seam, token)] })],
			}).compile();
			application = testingModule.createNestApplication();

			await expect(application.init()).rejects.toThrow(
				/must be listed in McpModule collaborators\.providers/,
			);
		},
	);

	it.each(COLLABORATOR_SEAMS)(
		"fails bootstrap when $label resolves a provider with the wrong shape",
		async ({ seam, requiredMethods }) => {
			const token = Symbol(`INVALID_${seam}`);
			const testingModule = await Test.createTestingModule({
				imports: [
					McpModule.forRoot({
						collaborators: { providers: [{ provide: token, useValue: {} }] },
						servers: [serverDefinitionForSeam(seam, token)],
					}),
				],
			}).compile();
			application = testingModule.createNestApplication();

			await expect(application.init()).rejects.toThrow(
				new RegExp(requiredMethods.map((method) => `${method}\\(\\)`).join(".*")),
			);
		},
	);
});

async function createApplication(
	options: Parameters<typeof McpModule.forRoot>[0],
	providers: readonly Provider[] = [],
): Promise<INestApplication> {
	const testingModule = await Test.createTestingModule({
		imports: [McpModule.forRoot(options)],
		providers: [...providers],
	}).compile();
	const application = testingModule.createNestApplication();
	await application.init();
	return application;
}

interface BuiltServerSession {
	readonly client: Client;
	readonly server: McpServer;
	close(): Promise<void>;
}

async function connectFreshBuild(
	runtime: McpServerRuntime,
	client: Client,
	era: "legacy" | "modern",
): Promise<BuiltServerSession> {
	const server = await runtime.createServer({ era });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		client,
		server,
		close: async () => {
			try {
				await client.close();
			} finally {
				await server.close();
			}
		},
	};
}

function serverDefinitionForSeam(
	seam: NestedServerCollaboratorSeam,
	token: symbol,
): McpNestServerDefinition {
	const definition = {
		name: `${seam}-server`,
		serverInfo: { name: `${seam}-server`, version: "1.0.0" },
	} as const;
	switch (seam) {
		case "jsonSchemaValidator":
			return { ...definition, serverOptions: { jsonSchemaValidator: token } };
		case "requestStateVerifier":
			return { ...definition, serverOptions: { requestState: { verifier: token } } };
		case "eventBus":
			return { ...definition, http: { eventBus: token } };
	}
	throw new Error("Unsupported collaborator seam");
}
