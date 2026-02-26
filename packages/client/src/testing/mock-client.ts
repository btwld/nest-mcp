import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptRequest,
  GetPromptResult,
  Implementation,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListToolsRequest,
  ListToolsResult,
  LoggingLevel,
  Prompt,
  ReadResourceRequest,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  SubscribeRequest,
  Tool,
  UnsubscribeRequest,
} from '@modelcontextprotocol/sdk/types.js';

type PingResult = Awaited<ReturnType<Client['ping']>>;

export class MockMcpClient {
  readonly name: string;
  private _connected = false;

  private _callToolResult: CallToolResult = { content: [] };
  private _readResourceResult: ReadResourceResult = { contents: [] };
  private _listToolsResult: ListToolsResult = { tools: [] };
  private _listResourcesResult: ListResourcesResult = { resources: [] };
  private _listResourceTemplatesResult: ListResourceTemplatesResult = { resourceTemplates: [] };
  private _getPromptResult: GetPromptResult = { messages: [] };
  private _listPromptsResult: ListPromptsResult = { prompts: [] };
  private _completeResult: CompleteResult = { completion: { values: [] } };
  private _pingResult: PingResult = {};
  private _serverCapabilities: ServerCapabilities | undefined;
  private _serverVersion: Implementation | undefined;
  private _instructions: string | undefined;
  private readonly _notificationHandlers = new Map<
    string,
    (notification: { method: string; params?: Record<string, unknown> }) => void | Promise<void>
  >();

  constructor(name = 'mock') {
    this.name = name;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async callTool(
    _params: CallToolRequest['params'],
    _options?: RequestOptions,
  ): Promise<CallToolResult> {
    return this._callToolResult;
  }

  async readResource(
    _params: ReadResourceRequest['params'],
    _options?: RequestOptions,
  ): Promise<ReadResourceResult> {
    return this._readResourceResult;
  }

  async listTools(
    _params?: ListToolsRequest['params'],
    _options?: RequestOptions,
  ): Promise<ListToolsResult> {
    return this._listToolsResult;
  }

  async listResources(
    _params?: ListResourcesRequest['params'],
    _options?: RequestOptions,
  ): Promise<ListResourcesResult> {
    return this._listResourcesResult;
  }

  async listResourceTemplates(
    _params?: ListResourceTemplatesRequest['params'],
    _options?: RequestOptions,
  ): Promise<ListResourceTemplatesResult> {
    return this._listResourceTemplatesResult;
  }

  async getPrompt(
    _params: GetPromptRequest['params'],
    _options?: RequestOptions,
  ): Promise<GetPromptResult> {
    return this._getPromptResult;
  }

  async listPrompts(
    _params?: ListPromptsRequest['params'],
    _options?: RequestOptions,
  ): Promise<ListPromptsResult> {
    return this._listPromptsResult;
  }

  async listAllTools(_options?: RequestOptions): Promise<Tool[]> {
    return (this._listToolsResult.tools ?? []) as Tool[];
  }

  async listAllResources(_options?: RequestOptions): Promise<Resource[]> {
    return (this._listResourcesResult.resources ?? []) as Resource[];
  }

  async listAllResourceTemplates(_options?: RequestOptions): Promise<ResourceTemplate[]> {
    return (this._listResourceTemplatesResult.resourceTemplates ?? []) as ResourceTemplate[];
  }

  async listAllPrompts(_options?: RequestOptions): Promise<Prompt[]> {
    return (this._listPromptsResult.prompts ?? []) as Prompt[];
  }

  async ping(_options?: RequestOptions): Promise<PingResult> {
    return this._pingResult;
  }

  async subscribeResource(
    _params: SubscribeRequest['params'],
    _options?: RequestOptions,
  ): Promise<Record<string, never>> {
    return {};
  }

  async unsubscribeResource(
    _params: UnsubscribeRequest['params'],
    _options?: RequestOptions,
  ): Promise<Record<string, never>> {
    return {};
  }

  async setLoggingLevel(
    _level: LoggingLevel,
    _options?: RequestOptions,
  ): Promise<Record<string, never>> {
    return {};
  }

  async complete(
    _params: CompleteRequest['params'],
    _options?: RequestOptions,
  ): Promise<CompleteResult> {
    return this._completeResult;
  }

  async sendRootsListChanged(): Promise<void> {
    // no-op
  }

  onNotification(
    method: string,
    handler: (notification: { method: string; params?: Record<string, unknown> }) => void | Promise<void>,
  ): void {
    this._notificationHandlers.set(method, handler);
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this._serverCapabilities;
  }

  getServerVersion(): Implementation | undefined {
    return this._serverVersion;
  }

  getInstructions(): string | undefined {
    return this._instructions;
  }

  getClient(): Client | null {
    return null;
  }

  // Helpers for setting mock return values
  setCallToolResult(result: CallToolResult): this {
    this._callToolResult = result;
    return this;
  }

  setReadResourceResult(result: ReadResourceResult): this {
    this._readResourceResult = result;
    return this;
  }

  setListToolsResult(result: ListToolsResult): this {
    this._listToolsResult = result;
    return this;
  }

  setListResourcesResult(result: ListResourcesResult): this {
    this._listResourcesResult = result;
    return this;
  }

  setListResourceTemplatesResult(result: ListResourceTemplatesResult): this {
    this._listResourceTemplatesResult = result;
    return this;
  }

  setGetPromptResult(result: GetPromptResult): this {
    this._getPromptResult = result;
    return this;
  }

  setListPromptsResult(result: ListPromptsResult): this {
    this._listPromptsResult = result;
    return this;
  }

  setCompleteResult(result: CompleteResult): this {
    this._completeResult = result;
    return this;
  }

  setServerCapabilities(capabilities: ServerCapabilities): this {
    this._serverCapabilities = capabilities;
    return this;
  }

  setServerVersion(version: Implementation): this {
    this._serverVersion = version;
    return this;
  }

  setInstructions(instructions: string): this {
    this._instructions = instructions;
    return this;
  }
}
