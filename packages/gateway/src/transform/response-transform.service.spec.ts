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
  });
});
