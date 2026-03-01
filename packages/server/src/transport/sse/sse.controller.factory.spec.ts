import 'reflect-metadata';
import { RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { createSseController } from './sse.controller.factory';

describe('createSseController', () => {
  const [SseController, SseMessagesController] = createSseController('/sse', '/messages');

  describe('return value', () => {
    it('returns an array of two controller classes', () => {
      const result = createSseController('/sse', '/msg');
      expect(result).toHaveLength(2);
      expect(typeof result[0]).toBe('function');
      expect(typeof result[1]).toBe('function');
    });
  });

  describe('SseController (GET endpoint)', () => {
    it('has the correct controller path', () => {
      expect(Reflect.getMetadata('path', SseController)).toBe('/sse');
    });

    it('uses VERSION_NEUTRAL', () => {
      expect(Reflect.getMetadata('__version__', SseController)).toBe(VERSION_NEUTRAL);
    });

    it('handleSse is bound to GET method', () => {
      // NestJS stores method metadata on the function itself, not the prototype+key slot
      expect(Reflect.getMetadata('method', SseController.prototype.handleSse)).toBe(
        RequestMethod.GET,
      );
    });

    it('delegates handleSse to sseService.createConnection', async () => {
      const createConnection = vi.fn().mockResolvedValue(undefined);
      const mockService = { createConnection };
      const ctrl = new (SseController as new (s: unknown) => { handleSse: (req: unknown, res: unknown) => Promise<void> })(mockService);
      const req = {};
      const res = {};
      await ctrl.handleSse(req, res);
      expect(createConnection).toHaveBeenCalledWith(req, res);
    });
  });

  describe('SseMessagesController (POST endpoint)', () => {
    it('has the correct controller path', () => {
      expect(Reflect.getMetadata('path', SseMessagesController)).toBe('/messages');
    });

    it('uses VERSION_NEUTRAL', () => {
      expect(Reflect.getMetadata('__version__', SseMessagesController)).toBe(VERSION_NEUTRAL);
    });

    it('handleMessage is bound to POST method', () => {
      expect(
        Reflect.getMetadata('method', SseMessagesController.prototype.handleMessage),
      ).toBe(RequestMethod.POST);
    });

    it('delegates handleMessage to sseService.handleMessage', async () => {
      const handleMessage = vi.fn().mockResolvedValue(undefined);
      const mockService = { handleMessage };
      const ctrl = new (SseMessagesController as new (s: unknown) => { handleMessage: (req: unknown, res: unknown) => Promise<void> })(mockService);
      const req = {};
      const res = {};
      await ctrl.handleMessage(req, res);
      expect(handleMessage).toHaveBeenCalledWith(req, res);
    });
  });

  describe('custom endpoints', () => {
    it('applies custom sseEndpoint to the first controller', () => {
      const [ctl] = createSseController('/custom-sse', '/custom-msg');
      expect(Reflect.getMetadata('path', ctl)).toBe('/custom-sse');
    });

    it('applies custom messagesEndpoint to the second controller', () => {
      const [, msgCtl] = createSseController('/custom-sse', '/custom-msg');
      expect(Reflect.getMetadata('path', msgCtl)).toBe('/custom-msg');
    });
  });
});
