import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import {
  getClassMetadata,
  getDecoratedMethods,
  getMethodMetadata,
  setClassMetadata,
  setMethodMetadata,
} from './metadata.utils';

const TEST_KEY = Symbol('test:key');

describe('setMethodMetadata / getMethodMetadata', () => {
  it('should set and get metadata on a method', () => {
    class MyClass {
      myMethod() {}
    }
    setMethodMetadata(TEST_KEY, { name: 'tool1' }, MyClass.prototype, 'myMethod');
    const result = getMethodMetadata(TEST_KEY, MyClass.prototype, 'myMethod');
    expect(result).toEqual({ name: 'tool1' });
  });

  it('should return undefined for missing metadata', () => {
    class MyClass {
      myMethod() {}
    }
    const result = getMethodMetadata(TEST_KEY, MyClass.prototype, 'myMethod');
    expect(result).toBeUndefined();
  });

  it('should handle symbol property keys', () => {
    const sym = Symbol('method');
    class MyClass {
      [sym]() {}
    }
    setMethodMetadata(TEST_KEY, 'value', MyClass.prototype, sym);
    expect(getMethodMetadata(TEST_KEY, MyClass.prototype, sym)).toBe('value');
  });
});

describe('setClassMetadata / getClassMetadata', () => {
  it('should set and get metadata on a class', () => {
    class MyClass {}
    setClassMetadata(TEST_KEY, { role: 'admin' }, MyClass);
    const result = getClassMetadata(TEST_KEY, MyClass);
    expect(result).toEqual({ role: 'admin' });
  });

  it('should return undefined for missing class metadata', () => {
    class MyClass {}
    const result = getClassMetadata(TEST_KEY, MyClass);
    expect(result).toBeUndefined();
  });
});

describe('getDecoratedMethods', () => {
  it('should collect methods that have the specified metadata', () => {
    class MyClass {
      handler1() {}
      handler2() {}
      noMetadata() {}
    }
    Reflect.defineMetadata(TEST_KEY, { name: 'h1' }, MyClass.prototype, 'handler1');
    Reflect.defineMetadata(TEST_KEY, { name: 'h2' }, MyClass.prototype, 'handler2');

    const result = getDecoratedMethods(TEST_KEY, MyClass);
    expect(result).toEqual([
      { propertyKey: 'handler1', metadata: { name: 'h1' } },
      { propertyKey: 'handler2', metadata: { name: 'h2' } },
    ]);
  });

  it('should return empty array when no methods have the metadata', () => {
    class MyClass {
      handler() {}
    }
    const result = getDecoratedMethods(TEST_KEY, MyClass);
    expect(result).toEqual([]);
  });

  it('should skip the constructor', () => {
    class MyClass {
      handler() {}
    }
    Reflect.defineMetadata(TEST_KEY, 'val', MyClass.prototype, 'constructor');
    Reflect.defineMetadata(TEST_KEY, 'val', MyClass.prototype, 'handler');

    const result = getDecoratedMethods(TEST_KEY, MyClass);
    expect(result).toEqual([{ propertyKey: 'handler', metadata: 'val' }]);
  });

  it('should work with an instance (prototype) as target', () => {
    class MyClass {
      handler() {}
    }
    Reflect.defineMetadata(TEST_KEY, 'data', MyClass.prototype, 'handler');

    const result = getDecoratedMethods(TEST_KEY, MyClass.prototype);
    expect(result).toEqual([{ propertyKey: 'handler', metadata: 'data' }]);
  });
});
