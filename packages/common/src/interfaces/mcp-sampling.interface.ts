export interface McpSamplingTextContent {
  type: 'text';
  text: string;
}

export interface McpSamplingImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpSamplingAudioContent {
  type: 'audio';
  data: string;
  mimeType: string;
}

export type McpSamplingContent =
  | McpSamplingTextContent
  | McpSamplingImageContent
  | McpSamplingAudioContent;

export interface McpSamplingMessage {
  role: 'user' | 'assistant';
  content: McpSamplingContent;
}

export interface McpModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface McpSamplingParams {
  messages: McpSamplingMessage[];
  maxTokens: number;
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
  modelPreferences?: McpModelPreferences;
}

export interface McpSamplingResult {
  role: 'user' | 'assistant';
  content: McpSamplingContent;
  model: string;
  stopReason?: string;
}
