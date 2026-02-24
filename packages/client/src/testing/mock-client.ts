export class MockMcpClient {
  readonly name: string;
  private _connected = false;

  private _callToolResult: unknown = { content: [] };
  private _readResourceResult: unknown = { contents: [] };
  private _listToolsResult: unknown = { tools: [] };
  private _listResourcesResult: unknown = { resources: [] };
  private _getPromptResult: unknown = { messages: [] };
  private _listPromptsResult: unknown = { prompts: [] };
  private _pingResult: unknown = {};

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

  async callTool(_params: unknown, _options?: unknown) {
    return this._callToolResult;
  }

  async readResource(_params: unknown, _options?: unknown) {
    return this._readResourceResult;
  }

  async listTools(_params?: unknown, _options?: unknown) {
    return this._listToolsResult;
  }

  async listResources(_params?: unknown, _options?: unknown) {
    return this._listResourcesResult;
  }

  async getPrompt(_params: unknown, _options?: unknown) {
    return this._getPromptResult;
  }

  async listPrompts(_params?: unknown, _options?: unknown) {
    return this._listPromptsResult;
  }

  async ping(_options?: unknown) {
    return this._pingResult;
  }

  getServerCapabilities() {
    return undefined;
  }

  getServerVersion() {
    return undefined;
  }

  getClient() {
    return null as unknown;
  }

  // Helpers for setting mock return values
  setCallToolResult(result: unknown): this {
    this._callToolResult = result;
    return this;
  }

  setReadResourceResult(result: unknown): this {
    this._readResourceResult = result;
    return this;
  }

  setListToolsResult(result: unknown): this {
    this._listToolsResult = result;
    return this;
  }

  setListResourcesResult(result: unknown): this {
    this._listResourcesResult = result;
    return this;
  }

  setGetPromptResult(result: unknown): this {
    this._getPromptResult = result;
    return this;
  }

  setListPromptsResult(result: unknown): this {
    this._listPromptsResult = result;
    return this;
  }
}
