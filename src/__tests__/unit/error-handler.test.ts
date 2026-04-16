/**
 * Tests unitarios para error handler
 */

import {
  transformError,
  getSuggestionForError,
  isErrorSafe,
  createStructuredError,
  sanitizeErrorMessage,
} from '../../utils/error-handler';
import { ErrorCode } from '../../types/common.types';

describe('transformError', () => {
  
  describe('✅ Error Mapping', () => {
    it('should map ECONNREFUSED to SFTP_CONNECTION_REFUSED', () => {
      const error = new Error('connect ECONNREFUSED');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.SFTP_CONNECTION_REFUSED);
      expect(result.message).toContain('Cannot reach');
      expect(result.severity).toBe('error');
      expect((result.context?.retryable as boolean)).toBe(true);
    });

    it('should map ENOTFOUND to SFTP_HOST_NOT_FOUND', () => {
      const error = new Error('getaddrinfo ENOTFOUND example.com');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.SFTP_HOST_NOT_FOUND);
      expect(result.message).toContain('Unable to resolve');
    });

    it('should map auth failure', () => {
      const error = new Error('All configured authentication methods failed');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.SFTP_AUTH_FAILED);
      expect(result.message).toContain('authenticate');
    });

    it('should map permission denied', () => {
      const error = new Error('Permission denied');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('should map ENOSPC (disk full)', () => {
      const error = new Error('ENOSPC: no space left on device');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.DISK_SPACE_ERROR);
      expect(result.message).toContain('Insufficient disk');
    });

    it('should map timeout', () => {
      const error = new Error('Timed out');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.TIMEOUT);
    });
  });

  describe('❌ Unknown Errors', () => {
    it('should handle unknown error types', () => {
      const error = new Error('Some weird error we never saw before');
      const result = transformError(error);

      expect(result.errorCode).toBe(ErrorCode.UNKNOWN);
      expect(result.message).toBe('An unexpected error occurred');
      expect(result.severity).toBe('error');
    });
  });

  describe('🔒 Security - No Sensitive Data', () => {
    it('should NOT expose credentials in user message', () => {
      const error = new Error('Failed with user:admin password:secret123');
      const result = transformError(error);

      expect(result.message).not.toContain('admin');
      expect(result.message).not.toContain('secret123');
    });

    it('should NOT expose IPs in user message', () => {
      const error = new Error('Connection to 192.168.1.100:22 failed');
      const result = transformError(error);

      expect(result.message).not.toContain('192.168');
    });

    it('should NOT expose internal paths in user message', () => {
      const error = new Error('/opt/n8n/production/sftp/utils.js:123');
      const result = transformError(error);

      expect(result.message).not.toContain('/opt/n8n');
    });
  });

  describe('Context Handling', () => {
    it('should include context when provided', () => {
      const error = new Error('ENOENT');
      const result = transformError(error, {
        affectedFile: 'report.csv',
        affectedFilePath: '/exports/report.csv',
        attemptedOperation: 'download',
      });

      expect(result.affectedFile).toBe('report.csv');
      expect(result.affectedFilePath).toBe('/exports/report.csv');
      expect(result.context?.attemptedOperation).toBe('download');
    });

    it('should generate unique ID', () => {
      const error = new Error('test');
      const result1 = transformError(error);
      const result2 = transformError(error);

      expect(result1.id).not.toBe(result2.id);
    });

    it('should include timestamp', () => {
      const error = new Error('test');
      const result = transformError(error);

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  describe('String Error Handling', () => {
    it('should handle string errors', () => {
      const result = transformError('Connection refused');

      expect(result.errorCode).toBe(ErrorCode.UNKNOWN);
      expect(result.message).toBe('An unexpected error occurred');
    });
  });
});

describe('getSuggestionForError', () => {
  
  it('should return appropriate suggestion for auth failure', () => {
    const suggestion = getSuggestionForError(ErrorCode.SFTP_AUTH_FAILED);
    expect(suggestion).toContain('credentials');
    expect(suggestion).toContain('credential store');
  });

  it('should return appropriate suggestion for connection refused', () => {
    const suggestion = getSuggestionForError(ErrorCode.SFTP_CONNECTION_REFUSED);
    expect(suggestion).toContain('running');
    expect(suggestion).toContain('accessible');
  });

  it('should return appropriate suggestion for disk space error', () => {
    const suggestion = getSuggestionForError(ErrorCode.DISK_SPACE_ERROR);
    expect(suggestion).toContain('Free up');
  });

  it('should return generic suggestion for unknown error', () => {
    const suggestion = getSuggestionForError('UNKNOWN_CODE');
    expect(suggestion).toContain('logs');
  });

  it('should NOT expose credentials in suggestion', () => {
    const suggestion = getSuggestionForError(ErrorCode.SFTP_AUTH_FAILED);
    expect(suggestion).not.toMatch(/password|secret|token/i);
  });

  it('should NOT expose IP addresses in suggestion', () => {
    const suggestion = getSuggestionForError(ErrorCode.SFTP_CONNECTION_REFUSED);
    expect(suggestion).not.toMatch(/\d{1,3}\.\d{1,3}/);
  });
});

describe('isErrorSafe', () => {
  
  it('should return true for safe error', () => {
    const safeError = {
      id: 'err_123',
      timestamp: '2024-04-16T10:00:00Z',
      severity: 'error' as const,
      errorCode: ErrorCode.TIMEOUT,
      message: 'Operation timed out',
      context: {
        attemptedOperation: 'download',
      },
    };

    expect(isErrorSafe(safeError)).toBe(true);
  });

  it('should return false for error string with password', () => {
    const unsafeString = 'Failed with password: secret123';
    expect(isErrorSafe(unsafeString)).toBe(false);
  });

  it('should return false for error string with private key', () => {
    const unsafeString = 'SSH error with privateKey from BEGIN RSA';
    expect(isErrorSafe(unsafeString)).toBe(false);
  });

  it('should return false for error with secret', () => {
    const unsafeString = 'Error: secret_value_123';
    expect(isErrorSafe(unsafeString)).toBe(false);
  });

  it('should handle StructuredError objects', () => {
    const safeError = {
      id: 'err_123',
      timestamp: '2024-04-16T10:00:00Z',
      severity: 'warning' as const,
      errorCode: 'TEST',
      message: 'Safe message',
    };
    expect(isErrorSafe(safeError)).toBe(true);
  });
});

describe('createStructuredError', () => {
  
  it('should create error with provided parameters', () => {
    const error = createStructuredError(
      'Test error message',
      ErrorCode.INVALID_PATH,
      'fatal',
      { attemptedOperation: 'validation' }
    );

    expect(error.message).toBe('Test error message');
    expect(error.errorCode).toBe(ErrorCode.INVALID_PATH);
    expect(error.severity).toBe('fatal');
    expect(error.context?.attemptedOperation).toBe('validation');
  });

  it('should use default values when not provided', () => {
    const error = createStructuredError('Error');

    expect(error.errorCode).toBe(ErrorCode.UNKNOWN);
    expect(error.severity).toBe('error');
    expect(error.message).toBe('Error');
  });

  it('should generate unique ID', () => {
    const error1 = createStructuredError('Err 1');
    const error2 = createStructuredError('Err 2');

    expect(error1.id).not.toBe(error2.id);
  });

  it('should include suggestion', () => {
    const error = createStructuredError(
      'Auth failed',
      ErrorCode.SFTP_AUTH_FAILED
    );

    expect(error.suggestion).toBeDefined();
    expect(error.suggestion?.length).toBeGreaterThan(0);
  });
});

describe('sanitizeErrorMessage', () => {
  
  it('should redact password', () => {
    const message = 'Failed with user=admin password=secret123';
    const sanitized = sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('secret123');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('should redact SSH key', () => {
    const message = 'SSH key=/home/user/.ssh/id_rsa not found';
    const sanitized = sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('/home/user');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('should redact user home directories', () => {
    const message = 'Error in /home/sftp_user/exports/data.csv';
    const sanitized = sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('/home/sftp_user');
    expect(sanitized).toContain('[USER]');
  });

  it('should redact IP addresses', () => {
    const message = 'Connection to 192.168.1.100 failed';
    const sanitized = sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('192.168');
    expect(sanitized).toContain('[IP]');
  });

  it('should handle multiple credentials', () => {
    const message =
      'Failed with user=admin password=secret token=abc123 key=/etc/ssl/key.pem';
    const sanitized = sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('secret');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).toContain('key=/etc/ssl/key.pem');
  });

  it('should leave safe messages unchanged', () => {
    const message = 'Connection timeout after 30 seconds';
    const sanitized = sanitizeErrorMessage(message);

    expect(sanitized).toBe(message);
  });
});
