import { type ExceptionFilter, Injectable, type Type } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  FILTER_CATCH_EXCEPTIONS,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

export interface FilterTarget {
  /**
   * Class constructor that received the decorator. Stored across our
   * capability metadata as a universal-constructor type; bridged to Nest's
   * concrete `Type` once inside this runner.
   */
  target: abstract new (...args: never[]) => unknown;
  methodName: string;
}

@Injectable()
export class McpExceptionFilterRunner {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Walk method-level then class-level `@UseFilters` metadata for the given
   * capability. If a filter declares (or is unscoped from) the error type, run
   * its `catch()` and return the rendered message. Returns `null` when no
   * filter matched, signalling the caller to fall through to default error
   * handling.
   */
  apply(error: Error, info: FilterTarget, request: unknown): string | null {
    // The metadata-storage type is purely a callable constructor signature —
    // not enough for `Reflector.get` (needs `Function` | `Type`) or for
    // reading `.prototype`. Bridge to Nest's `Type` exactly once.
    const clazz = info.target as Type;
    const method = clazz.prototype?.[info.methodName];

    const methodFilters = method
      ? (this.reflector.get<Type<ExceptionFilter>[]>(EXCEPTION_FILTERS_METADATA, method) ?? [])
      : [];
    const classFilters =
      this.reflector.get<Type<ExceptionFilter>[]>(EXCEPTION_FILTERS_METADATA, clazz) ?? [];

    const matched = [...methodFilters, ...classFilters].find((f) =>
      this.matchesError(error, f),
    );
    if (!matched) return null;

    const host = new ExecutionContextHost([request], clazz, method);
    host.setType('http');

    const result = new matched().catch(error, host);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  private matchesError(error: Error, filter: Type<ExceptionFilter>): boolean {
    const exceptionTypes =
      this.reflector.get<Type<Error>[]>(FILTER_CATCH_EXCEPTIONS, filter) ?? [];

    if (exceptionTypes.length === 0) return true;
    return exceptionTypes.some((t) => error instanceof t);
  }
}
