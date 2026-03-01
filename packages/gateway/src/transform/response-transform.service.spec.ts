import { ResponseTransformService, type ToolCallResponse } from './response-transform.service';

describe('ResponseTransformService', () => {
  let service: ResponseTransformService;

  beforeEach(() => {
    service = new ResponseTransformService();
  });

  const baseResponse: ToolCallResponse = {
    toolName: 'listRepos',
    upstreamName: 'github',
    content: [{ type: 'text', text: 'hello' }],
    isError: false,
  };

  describe('apply', () => {
    it('should pass through response unchanged when no transforms are registered', async () => {
      const result = await service.apply(baseResponse);
      expect(result).toEqual(baseResponse);
    });

    it('should apply a single transform', async () => {
      service.register((res) => ({
        ...res,
        content: [...res.content, { type: 'text', text: 'appended' }],
      }));

      const result = await service.apply(baseResponse);

      expect(result.content).toHaveLength(2);
    });

    it('should chain multiple transforms in order', async () => {
      service.register((res) => ({ ...res, toolName: `${res.toolName}_1` }));
      service.register((res) => ({ ...res, toolName: `${res.toolName}_2` }));

      const result = await service.apply(baseResponse);

      expect(result.toolName).toBe('listRepos_1_2');
    });

    it('should support async transforms', async () => {
      service.register(async (res) => {
        return { ...res, isError: true };
      });

      const result = await service.apply(baseResponse);

      expect(result.isError).toBe(true);
    });

    it('should propagate errors from transforms', async () => {
      service.register(() => {
        throw new Error('transform failed');
      });

      await expect(service.apply(baseResponse)).rejects.toThrow('transform failed');
    });

    it('transforms earlier in the chain see original values', async () => {
      const seen: string[] = [];

      service.register((res) => {
        seen.push(res.toolName);
        return { ...res, toolName: 'renamed' };
      });
      service.register((res) => {
        seen.push(res.toolName);
        return res;
      });

      await service.apply(baseResponse);
      expect(seen[0]).toBe('listRepos');
      expect(seen[1]).toBe('renamed');
    });

    it('does not mutate the original response object', async () => {
      const original = { ...baseResponse };

      service.register((res) => ({ ...res, toolName: 'mutated' }));
      await service.apply(baseResponse);

      expect(baseResponse.toolName).toBe(original.toolName);
    });

    it('can toggle isError field', async () => {
      service.register((res) => ({ ...res, isError: !res.isError }));

      const result = await service.apply({ ...baseResponse, isError: false });

      expect(result.isError).toBe(true);
    });

    it('can add items to content array', async () => {
      service.register((res) => ({
        ...res,
        content: [...res.content, { type: 'text' as const, text: 'extra' }],
      }));

      const result = await service.apply(baseResponse);

      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toEqual({ type: 'text', text: 'extra' });
    });
  });
});
