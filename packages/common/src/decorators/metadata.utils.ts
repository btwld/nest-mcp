import 'reflect-metadata';

/**
 * Set metadata on a target (class or method).
 */
export function setMethodMetadata<T>(
  metadataKey: symbol,
  value: T,
  target: object,
  propertyKey: string | symbol,
): void {
  Reflect.defineMetadata(metadataKey, value, target, propertyKey);
}

/**
 * Get metadata from a target method.
 */
export function getMethodMetadata<T>(
  metadataKey: symbol,
  target: object,
  propertyKey: string | symbol,
): T | undefined {
  return Reflect.getMetadata(metadataKey, target, propertyKey);
}

/**
 * Set metadata on a class.
 */
export function setClassMetadata<T>(
  metadataKey: symbol,
  value: T,
  target: Function,
): void {
  Reflect.defineMetadata(metadataKey, value, target);
}

/**
 * Get metadata from a class.
 */
export function getClassMetadata<T>(
  metadataKey: symbol,
  target: Function,
): T | undefined {
  return Reflect.getMetadata(metadataKey, target);
}

/**
 * Collect all methods on a class that have a specific metadata key.
 */
export function getDecoratedMethods<T>(
  metadataKey: symbol,
  target: object,
): Array<{ propertyKey: string; metadata: T }> {
  const prototype = typeof target === 'function' ? target.prototype : target;
  const methods: Array<{ propertyKey: string; metadata: T }> = [];

  const propertyNames = Object.getOwnPropertyNames(prototype);
  for (const propertyKey of propertyNames) {
    if (propertyKey === 'constructor') continue;
    const metadata = Reflect.getMetadata(metadataKey, prototype, propertyKey);
    if (metadata !== undefined) {
      methods.push({ propertyKey, metadata });
    }
  }

  return methods;
}
