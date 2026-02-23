export interface ServerCapabilities {
  experimental?: Record<string, unknown>;
  logging?: Record<string, never>;
  completions?: Record<string, never>;
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
}

export interface ClientCapabilities {
  experimental?: Record<string, unknown>;
  roots?: { listChanged?: boolean };
  sampling?: Record<string, never>;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

export interface InitializeRequest {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
}
