import {
  MCP_AUTO_CONTROLLER_METADATA,
  MCP_AUTO_EXPOSE_METADATA,
  MCP_AUTO_HIDE_METADATA,
  type McpExposeControllerOptions,
  type McpExposeOptions,
} from './metadata-keys';

export {
  MCP_AUTO_EXPOSE_METADATA,
  MCP_AUTO_HIDE_METADATA,
  MCP_AUTO_CONTROLLER_METADATA,
  type McpExposeOptions,
  type McpExposeControllerOptions,
};

type DualDecorator = (
  target: object,
  propertyKey?: string | symbol,
  descriptor?: PropertyDescriptor,
) => void;

/**
 * Mark a controller method (or all methods of a controller) for explicit MCP
 * exposure. In `mode: 'opt-in'`, this is required. In `mode: 'all'`, this is
 * optional and serves to override the auto-derived name/description/schema.
 */
export function McpExpose(options: McpExposeOptions = {}): DualDecorator {
  return (target, propertyKey) => {
    if (propertyKey !== undefined) {
      Reflect.defineMetadata(MCP_AUTO_EXPOSE_METADATA, options, target, propertyKey);
      return;
    }
    Reflect.defineMetadata(MCP_AUTO_EXPOSE_METADATA, options, target);
  };
}

/** Always exclude this method (or controller) from MCP exposure. */
export function McpHide(): DualDecorator {
  return (target, propertyKey) => {
    if (propertyKey !== undefined) {
      Reflect.defineMetadata(MCP_AUTO_HIDE_METADATA, true, target, propertyKey);
      return;
    }
    Reflect.defineMetadata(MCP_AUTO_HIDE_METADATA, true, target);
  };
}

/** Apply controller-level configuration (mode override, namespace, serverName). */
export function McpExposeController(options: McpExposeControllerOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(MCP_AUTO_CONTROLLER_METADATA, options, target);
  };
}
