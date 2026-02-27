import 'reflect-metadata';
import { StderrLogger } from './stderr-logger';

describe('StderrLogger', () => {
  let logger: StderrLogger;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger = new StderrLogger();
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  // --- output destination ---

  it('writes log to stderr (not stdout)', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.log('hello');
    expect(writeSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  // --- log levels ---

  it('writes log level output', () => {
    logger.log('hello');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('LOG'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('hello'));
  });

  it('writes error level output', () => {
    logger.error('oops');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('oops'));
  });

  it('writes trace on a separate line when provided', () => {
    logger.error('oops', 'Error: at line 1\n    at foo');
    const calls = writeSpy.mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('ERROR'))).toBe(true);
    expect(calls.some((s) => s.includes('Error: at line 1'))).toBe(true);
  });

  it('does not write extra trace line when trace is absent', () => {
    logger.error('just error');
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('writes warn level output', () => {
    logger.warn('careful');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('WARN'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('careful'));
  });

  it('writes debug level output', () => {
    logger.debug('details');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('DEBUG'));
  });

  it('writes verbose level output', () => {
    logger.verbose('trace');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('VERBOSE'));
  });

  it('writes fatal level output', () => {
    logger.fatal('crash');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('FATAL'));
  });

  // --- context ---

  it('includes context bracket when provided', () => {
    logger.log('message', 'MyService');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('[MyService]'));
  });

  it('omits context bracket when not provided', () => {
    logger.log('no ctx');
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).not.toMatch(/\[.*\]/);
  });

  // --- timestamp ---

  it('includes an ISO 8601 timestamp', () => {
    logger.log('ts test');
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // --- log level filtering ---

  it('suppresses levels not in the configured set', () => {
    const limited = new StderrLogger({ logLevels: ['error'] });
    limited.log('silent');
    limited.warn('also silent');
    limited.debug('silent too');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('emits only levels in the configured set', () => {
    const limited = new StderrLogger({ logLevels: ['error'] });
    limited.error('loud');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });

  it('respects setLogLevels update', () => {
    logger.setLogLevels(['error']);
    logger.log('silent');
    expect(writeSpy).not.toHaveBeenCalled();
    logger.error('loud');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });

  it('can re-add levels after setLogLevels', () => {
    logger.setLogLevels(['error']);
    logger.setLogLevels(['log', 'warn']);
    logger.log('visible');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('LOG'));
  });
});
