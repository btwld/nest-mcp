import { collectFulfilled } from './settled-results';

describe('collectFulfilled', () => {
  it('should collect values from fulfilled results', () => {
    const results: PromiseSettledResult<number[]>[] = [
      { status: 'fulfilled', value: [1, 2] },
      { status: 'fulfilled', value: [3] },
    ];

    expect(collectFulfilled(results)).toEqual([1, 2, 3]);
  });

  it('should skip rejected results', () => {
    const results: PromiseSettledResult<string[]>[] = [
      { status: 'fulfilled', value: ['a'] },
      { status: 'rejected', reason: new Error('fail') },
      { status: 'fulfilled', value: ['b'] },
    ];

    expect(collectFulfilled(results)).toEqual(['a', 'b']);
  });

  it('should return empty array when all rejected', () => {
    const results: PromiseSettledResult<number[]>[] = [
      { status: 'rejected', reason: new Error('fail') },
    ];

    expect(collectFulfilled(results)).toEqual([]);
  });

  it('should return empty array for empty input', () => {
    expect(collectFulfilled([])).toEqual([]);
  });

  it('should handle fulfilled results with empty arrays', () => {
    const results: PromiseSettledResult<number[]>[] = [
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [1] },
    ];

    expect(collectFulfilled(results)).toEqual([1]);
  });
});
