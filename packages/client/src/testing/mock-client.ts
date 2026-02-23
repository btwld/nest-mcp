export class MockMcpClient {
  readonly name: string;
  private _connected = false;

  private _callToolResult: any = { content: [] };
  private _readResourceResult: any = { contents: [] };
  private _listToolsResult: any = { tools: [] };
  private _listResourcesResult: any = { resources: [] };
  private _getPromptResult: any = { messages: [] };
  private _listPromptsResult: any = { prompts: [] };
  private _pingResult: any = {};

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

  async callTool(_params: any, _options?: any) {
    return this._callToolResult;
  }

  async readResource(_params: any, _options?: any) {
    return this._readResourceResult;
  }

  async listTools(_params?: any, _options?: any) {
    return this._listToolsResult;
  }

  async listResources(_params?: any, _options?: any) {
    return this._listResourcesResult;
  }

  async getPrompt(_params: any, _options?: any) {
    return this._getPromptResult;
  }

  async listPrompts(_params?: any, _options?: any) {
    return this._listPromptsResult;
  }

  async ping(_options?: any) {
    return this._pingResult;
  }

  getServerCapabilities() {
    return undefined;
  }

  getServerVersion() {
    return undefined;
  }

  getClient() {
    return null as any;
  }

  // Helpers for setting mock return values
  setCallToolResult(result: any): this {
    this._callToolResult = result;
    return this;
  }

  setReadResourceResult(result: any): this {
    this._readResourceResult = result;
    return this;
  }

  setListToolsResult(result: any): this {
    this._listToolsResult = result;
    return this;
  }

  setListResourcesResult(result: any): this {
    this._listResourcesResult = result;
    return this;
  }

  setGetPromptResult(result: any): this {
    this._getPromptResult = result;
    return this;
  }

  setListPromptsResult(result: any): this {
    this._listPromptsResult = result;
    return this;
  }
}
