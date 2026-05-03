import type { Type } from '@nestjs/common';
import type { McpExposeOptions } from '../decorators/metadata-keys';
import type { ResolvedParam } from './param-introspector';

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL';

export interface RouteDescriptor {
  controllerType: Type;
  controllerName: string;
  methodName: string;
  verb: HttpVerb;
  /** Combined controller-prefix + route-path (informational). */
  fullPath: string;
  params: ResolvedParam[];
  expose?: McpExposeOptions;
  isHidden: boolean;
  /** When the controller's instance has a request scope, dynamic dispatch is required. */
  isRequestScoped: boolean;
}
