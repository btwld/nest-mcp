import 'reflect-metadata';
import { RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { createStreamableHttpController } from './streamable.controller.factory';

describe('createStreamableHttpController', () => {
  const Controller = createStreamableHttpController('/mcp');

  describe('return value', () => {
    it('returns a single controller class', () => {
      const ctrl = createStreamableHttpController('/mcp');
      expect(typeof ctrl).toBe('function');
    });
  });

  describe('controller metadata', () => {
    it('has the correct controller path', () => {
      expect(Reflect.getMetadata('path', Controller)).toBe('/mcp');
    });

    it('uses VERSION_NEUTRAL', () => {
      expect(Reflect.getMetadata('__version__', Controller)).toBe(VERSION_NEUTRAL);
    });
  });

  describe('HTTP method bindings', () => {
    // NestJS stores method metadata on the function itself (descriptor.value)
    it('handlePost is bound to POST', () => {
      expect(Reflect.getMetadata('method', Controller.prototype.handlePost)).toBe(
        RequestMethod.POST,
      );
    });

    it('handleGet is bound to GET', () => {
      expect(Reflect.getMetadata('method', Controller.prototype.handleGet)).toBe(
        RequestMethod.GET,
      );
    });

    it('handleDelete is bound to DELETE', () => {
      expect(Reflect.getMetadata('method', Controller.prototype.handleDelete)).toBe(
        RequestMethod.DELETE,
      );
    });
  });

  describe('delegation', () => {
    type MockService = {
      handlePostRequest: ReturnType<typeof vi.fn>;
      handleGetRequest: ReturnType<typeof vi.fn>;
      handleDeleteRequest: ReturnType<typeof vi.fn>;
    };

    type ControllerInstance = {
      handlePost(req: unknown, res: unknown): Promise<void>;
      handleGet(req: unknown, res: unknown): Promise<void>;
      handleDelete(req: unknown, res: unknown): Promise<void>;
    };

    function makeInstance(service: MockService): ControllerInstance {
      return new (Controller as new (s: unknown) => ControllerInstance)(service);
    }

    it('handlePost delegates to streamableService.handlePostRequest', async () => {
      const service: MockService = {
        handlePostRequest: vi.fn().mockResolvedValue(undefined),
        handleGetRequest: vi.fn(),
        handleDeleteRequest: vi.fn(),
      };
      const ctrl = makeInstance(service);
      const req = {};
      const res = {};
      await ctrl.handlePost(req, res);
      expect(service.handlePostRequest).toHaveBeenCalledWith(req, res);
    });

    it('handleGet delegates to streamableService.handleGetRequest', async () => {
      const service: MockService = {
        handlePostRequest: vi.fn(),
        handleGetRequest: vi.fn().mockResolvedValue(undefined),
        handleDeleteRequest: vi.fn(),
      };
      const ctrl = makeInstance(service);
      const req = {};
      const res = {};
      await ctrl.handleGet(req, res);
      expect(service.handleGetRequest).toHaveBeenCalledWith(req, res);
    });

    it('handleDelete delegates to streamableService.handleDeleteRequest', async () => {
      const service: MockService = {
        handlePostRequest: vi.fn(),
        handleGetRequest: vi.fn(),
        handleDeleteRequest: vi.fn().mockResolvedValue(undefined),
      };
      const ctrl = makeInstance(service);
      const req = {};
      const res = {};
      await ctrl.handleDelete(req, res);
      expect(service.handleDeleteRequest).toHaveBeenCalledWith(req, res);
    });
  });

  describe('custom endpoint', () => {
    it('applies a custom path to the controller', () => {
      const CustomController = createStreamableHttpController('/custom-mcp');
      expect(Reflect.getMetadata('path', CustomController)).toBe('/custom-mcp');
    });
  });
});
