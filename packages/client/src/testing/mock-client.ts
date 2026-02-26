import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolRequest,
  CallToolResult,
  GetPromptRequest,
  GetPromptResult,
  Implementation,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListToolsRequest,
  ListToolsResult,
  Prompt,
  ReadResourceRequest,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

type PingResult = Awaited<ReturnType<Client['ping']>>;

export class MockMcpClient {
  readonly name: string;
  private _connected = false;

  private _callToolResult: CallToolResult = { content: [] };
  private _readResourceResult: ReadResourceResult = { contents: [] };
  private _listToolsResult: ListToolsResult = { tools: [] };
  private _listResourcesResult: ListResourcesResult = { resources: [] };
  private _getPromptResult: GetPromptResult = { messages: [] };
  private _listPromptsResult: ListPromptsResult = { prompts: [] };
  private _pingResult: PingResult = {};

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
    return [];
  }

  async listAllPrompts(_options?: RequestOptions): Promise<Prompt[]> {
    return (this._listPromptsResult.prompts ?? []) as Prompt[];
  }

  async ping(_options?: RequestOptions): Promise<PingResult> {
    return this._pingResult;
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return undefined;
  }

  getServerVersion(): Implementation | undefined {
    return undefined;
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

  setGetPromptResult(result: GetPromptResult): this {
    this._getPromptResult = result;
    return this;
  }

  setListPromptsResult(result: ListPromptsResult): this {
    this._listPromptsResult = result;
    return this;
  }
}
