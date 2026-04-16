/**
 * Tests unitarios para logger
 */

import {
  createSecureLogger,
  logEvent,
  logError,
  logWarning,
  logDebug,
  LogEvent,
} from '../../utils/logger';

const originalNodeEnv = process.env.NODE_ENV;

beforeAll(() => {
  process.env.NODE_ENV = 'production';
});

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('createSecureLogger', () => {
  it('should create logger instance', () => {
    const logger = createSecureLogger('unit-test');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should create independent logger instances', () => {
    const logger1 = createSecureLogger('module-1');
    const logger2 = createSecureLogger('module-2');

    expect(logger1).not.toBe(logger2);
  });
});

describe('logEvent', () => {
  it('should log execution started event', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logEvent(logger, {
        event: LogEvent.EXECUTION_STARTED,
        workflowId: 'wf_123',
      });
    }).not.toThrow();
  });

  it('should log event with explicit debug level', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logEvent(
        logger,
        {
          event: LogEvent.PATTERN_VALIDATED,
          operationName: 'regex_validation',
        },
        'debug'
      );
    }).not.toThrow();
  });

  it('should include timestamp automatically when omitted', () => {
    const logger = createSecureLogger('test');
    const data: { event: LogEvent; timestamp?: string } = {
      event: LogEvent.EXECUTION_COMPLETED,
    };

    logEvent(logger, data);
    expect(data.timestamp).toBeDefined();
  });
});

describe('logError', () => {
  it('should log error with code and message', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logError(logger, 'SFTP_AUTH_FAILED', 'Authentication failed');
    }).not.toThrow();
  });

  it('should accept optional context object', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logError(logger, 'CONNECTION_ERROR', 'Cannot connect', {
        host: 'example.com',
        port: 22,
      });
    }).not.toThrow();
  });
});

describe('logWarning', () => {
  it('should log warning message', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logWarning(logger, 'Potential issue detected');
    }).not.toThrow();
  });

  it('should log warning with context', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logWarning(logger, 'Near timeout threshold', {
        threshold: 30,
        elapsed: 28,
      });
    }).not.toThrow();
  });
});

describe('logDebug', () => {
  it('should log debug event data', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logDebug(logger, 'debug_event', {
        step: 1,
        detail: 'processing',
      });
    }).not.toThrow();
  });
});

describe('secure logging behavior', () => {
  it('should not throw when sensitive fields are present (redaction handled by pino)', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logEvent(logger, {
        event: LogEvent.CONNECTION_ESTABLISHED,
        credential: {
          password: 'secret123',
          privateKey: 'mock-private-key-content',
          token: 'token123',
        },
      });
    }).not.toThrow();
  });

  it('should log all critical event families', () => {
    const logger = createSecureLogger('test');

    expect(() => {
      logEvent(logger, { event: LogEvent.EXECUTION_FAILED });
      logEvent(logger, { event: LogEvent.CONNECTION_CLOSED });
      logEvent(logger, { event: LogEvent.FILE_DOWNLOAD_COMPLETED });
      logEvent(logger, { event: LogEvent.FILTER_APPLIED });
      logEvent(logger, { event: LogEvent.ERROR_OCCURRED });
    }).not.toThrow();
  });
});
