export const JSONRPC_VERSION = '2.0' as const;
export const LATEST_PROTOCOL_VERSION = '2025-11-25' as const;

// MCP method names
export const MCP_METHODS = {
  // Lifecycle
  INITIALIZE: 'initialize',
  PING: 'ping',

  // Tools
  TOOLS_LIST: 'tools/list',
  TOOLS_CALL: 'tools/call',

  // Resources
  RESOURCES_LIST: 'resources/list',
  RESOURCES_READ: 'resources/read',
  RESOURCES_SUBSCRIBE: 'resources/subscribe',
  RESOURCES_UNSUBSCRIBE: 'resources/unsubscribe',
  RESOURCES_TEMPLATES_LIST: 'resources/templates/list',

  // Prompts
  PROMPTS_LIST: 'prompts/list',
  PROMPTS_GET: 'prompts/get',

  // Completions
  COMPLETION_COMPLETE: 'completion/complete',

  // Logging
  LOGGING_SET_LEVEL: 'logging/setLevel',

  // Sampling (server → client)
  SAMPLING_CREATE_MESSAGE: 'sampling/createMessage',

  // Tasks (server → client)
  TASKS_GET: 'tasks/get',
  TASKS_RESULT: 'tasks/result',
  TASKS_LIST: 'tasks/list',
  TASKS_CANCEL: 'tasks/cancel',

  // Elicitation (server → client)
  ELICITATION_CREATE: 'elicitation/create',

  // Roots (server → client)
  ROOTS_LIST: 'roots/list',

  // Notifications
  NOTIFICATION_INITIALIZED: 'notifications/initialized',
  NOTIFICATION_CANCELLED: 'notifications/cancelled',
  NOTIFICATION_PROGRESS: 'notifications/progress',
  NOTIFICATION_TOOLS_LIST_CHANGED: 'notifications/tools/list_changed',
  NOTIFICATION_RESOURCES_LIST_CHANGED: 'notifications/resources/list_changed',
  NOTIFICATION_RESOURCES_UPDATED: 'notifications/resources/updated',
  NOTIFICATION_PROMPTS_LIST_CHANGED: 'notifications/prompts/list_changed',
  NOTIFICATION_MESSAGE: 'notifications/message',
  NOTIFICATION_TASKS_STATUS: 'notifications/tasks/status',
  NOTIFICATION_ELICITATION_COMPLETE: 'notifications/elicitation/complete',
  NOTIFICATION_ROOTS_LIST_CHANGED: 'notifications/roots/list_changed',
} as const;

export type McpMethod = (typeof MCP_METHODS)[keyof typeof MCP_METHODS];
