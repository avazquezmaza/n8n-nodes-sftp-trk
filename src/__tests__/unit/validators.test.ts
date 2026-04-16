/**
 * Tests unitarios para validadores
 * 
 * Coverage: >90% para funciones críticas de seguridad
 */

import {
  validateRemotePath,
  validateRegexPattern,
  validateSizeLimits,
  validateFileExtension,
  validateGlobPattern,
  validateSftpCredential,
  validateDownloadParameters,
  validateNoCredentialsInParameters,
  SIZE_LIMITS,
} from '../../utils/validators';

describe('validateRemotePath', () => {
  
  describe('✅ Valid Paths', () => {
    it('should accept simple absolute paths', () => {
      expect(() => validateRemotePath('/exports/reports')).not.toThrow();
      expect(() => validateRemotePath('/')).toThrow();
    });

    it('should accept paths with multiple levels', () => {
      expect(() => validateRemotePath('/exports/reports/2024/q1')).not.toThrow();
    });

    it('should accept paths with numbers and underscores', () => {
      expect(() => validateRemotePath('/exports/data_2024_v1')).not.toThrow();
    });

    it('should accept paths with hyphens', () => {
      expect(() => validateRemotePath('/exports/report-data')).not.toThrow();
    });
  });

  describe('❌ Path Traversal Prevention', () => {
    it('should reject paths with ../', () => {
      expect(() => validateRemotePath('/exports/../../../etc/passwd')).toThrow(
        /PATH_TRAVERSAL_ATTEMPT|INVALID_PATH/
      );
    });

    it('should reject paths with ..\\', () => {
      expect(() => validateRemotePath('/exports\\..\\windows\\system32')).toThrow(
        /INVALID_PATH|PATH_TRAVERSAL/
      );
    });

    it('should reject paths starting with ..', () => {
      expect(() => validateRemotePath('../etc/passwd')).toThrow();
    });

    it('should reject paths with just ..', () => {
      expect(() => validateRemotePath('/exports/..')).toThrow(
        /PATH_TRAVERSAL|INVALID_PATH/
      );
    });
  });

  describe('❌ Special Characters Prevention', () => {
    it('should reject paths with command injection', () => {
      expect(() => validateRemotePath('/exports/$(rm -rf /)')).toThrow(
        /INVALID_PATH|special/i
      );
    });

    it('should reject paths with backticks', () => {
      expect(() => validateRemotePath('/exports/`cat /etc/passwd`')).toThrow();
    });

    it('should reject paths with pipes', () => {
      expect(() => validateRemotePath('/exports/file | grep')).toThrow();
    });

    it('should reject paths with semicolons', () => {
      expect(() => validateRemotePath('/exports/file; DROP TABLE')).toThrow();
    });

    it('should reject paths with ampersands', () => {
      expect(() => validateRemotePath('/exports/file & rm -rf /')).toThrow();
    });

    it('should reject paths with tilde', () => {
      expect(() => validateRemotePath('~/exports')).toThrow();
    });
  });

  describe('❌ Input Validation', () => {
    it('should reject null paths', () => {
      expect(() => validateRemotePath(null)).toThrow();
    });

    it('should reject undefined paths', () => {
      expect(() => validateRemotePath(undefined)).toThrow();
    });

    it('should reject empty strings', () => {
      expect(() => validateRemotePath('')).toThrow();
    });

    it('should reject non-string paths', () => {
      expect(() => validateRemotePath(123 as any)).toThrow();
    });

    it('should reject relative paths', () => {
      expect(() => validateRemotePath('exports/reports')).toThrow(
        /absolute|must be absolute/i
      );
    });

    it('should reject paths starting with dot', () => {
      expect(() => validateRemotePath('./exports')).toThrow();
    });
  });

  describe('Base Path Validation', () => {
    it('should enforce custom base path', () => {
      expect(() =>
        validateRemotePath('/exports/reports', '/exports')
      ).not.toThrow();

      expect(() =>
        validateRemotePath('/other/reports', '/exports')
      ).toThrow(
        /outside allowed directory/i
      );
    });

    it('should allow root as base path', () => {
      expect(() => validateRemotePath('/any/path', '/')).not.toThrow();
    });
  });
});

describe('validateRegexPattern', () => {
  
  describe('✅ Valid Patterns', () => {
    it('should accept simple patterns', () => {
      expect(validateRegexPattern('^report')).toEqual(expect.any(RegExp));
    });

    it('should accept patterns with character classes', () => {
      expect(validateRegexPattern('[a-z]{1,5}')).toEqual(expect.any(RegExp));
    });

    it('should accept complex patterns', () => {
      expect(validateRegexPattern('report_[0-9]{4}\\.csv')).toEqual(
        expect.any(RegExp)
      );
    });

    it('should return compiled RegExp', () => {
      const result = validateRegexPattern('test');
      expect(result).toBeInstanceOf(RegExp);
      expect(result.test('test')).toBe(true);
    });
  });

  describe('❌ ReDoS Prevention', () => {
    it('should reject exponential backtracking patterns', () => {
      expect(() => {
        validateRegexPattern('(a+)+$');
      }).toThrow(/REDOS|ReDoS|backtracking/i);
    });

    it('should reject (a|a)*$ pattern', () => {
      expect(() => {
        validateRegexPattern('(a|a)*$');
      }).toThrow(/REDOS|dangerous/i);
    });

    it('should reject repeated .* patterns', () => {
      expect(() => {
        validateRegexPattern('.*.*');
      }).toThrow(/REDOS|dangerous/i);
    });

    it('should reject very long patterns', () => {
      const longPattern = 'a'.repeat(SIZE_LIMITS.MAX_PATTERN_LENGTH + 1);
      expect(() => {
        validateRegexPattern(longPattern);
      }).toThrow(/too long|exceeds/i);
    });
  });

  describe('❌ Syntax Validation', () => {
    it('should reject invalid regex syntax', () => {
      expect(() => {
        validateRegexPattern('[invalid');
      }).toThrow(/invalid|syntax/i);
    });

    it('should reject malformed character classes', () => {
      expect(() => {
        validateRegexPattern('([^]');
      }).toThrow(/invalid|syntax/i);
    });

    it('should reject unmatched parentheses', () => {
      expect(() => {
        validateRegexPattern('(unclosed');
      }).toThrow(/invalid|syntax/i);
    });
  });

  describe('❌ Input Validation', () => {
    it('should reject null patterns', () => {
      expect(() => {
        validateRegexPattern(null);
      }).toThrow();
    });

    it('should reject empty patterns', () => {
      expect(() => {
        validateRegexPattern('');
      }).toThrow();
    });

    it('should reject non-string patterns', () => {
      expect(() => {
        validateRegexPattern(123 as any);
      }).toThrow();
    });
  });
});

describe('validateSizeLimits', () => {
  
  describe('✅ Valid Sizes', () => {
    it('should accept valid file sizes', () => {
      expect(() => {
        validateSizeLimits({ maxFileSizeMB: 100 });
      }).not.toThrow();
    });

    it('should accept valid file counts', () => {
      expect(() => {
        validateSizeLimits({ maxFilesCount: 500 });
      }).not.toThrow();
    });

    it('should accept valid timeouts', () => {
      expect(() => {
        validateSizeLimits({ fileTimeoutSeconds: 300 });
      }).not.toThrow();
    });

    it('should accept zero as unlimited file size', () => {
      expect(() => {
        validateSizeLimits({ maxFileSizeMB: 0 });
      }).not.toThrow();
    });

    it('should accept combined parameters', () => {
      expect(() => {
        validateSizeLimits({
          maxFileSizeMB: 1024,
          maxFilesCount: 100,
          fileTimeoutSeconds: 300,
        });
      }).not.toThrow();
    });
  });

  describe('❌ Size Boundaries', () => {
    it('should reject too small file size', () => {
      expect(() => {
        validateSizeLimits({ maxFileSizeMB: 0.0001 });
      }).toThrow(/too small|min/i);
    });

    it('should reject too large file size', () => {
      expect(() => {
        validateSizeLimits({ maxFileSizeMB: 10000 });
      }).toThrow(/too large|max/i);
    });

    it('should reject zero files count', () => {
      expect(() => {
        validateSizeLimits({ maxFilesCount: 0 });
      }).toThrow();
    });

    it('should reject excessive file count', () => {
      expect(() => {
        validateSizeLimits({ maxFilesCount: 99999 });
      }).toThrow(/too large|max/i);
    });

    it('should reject too short timeout', () => {
      expect(() => {
        validateSizeLimits({ fileTimeoutSeconds: 5 });
      }).toThrow(/too short|min/i);
    });

    it('should reject too long timeout', () => {
      expect(() => {
        validateSizeLimits({ fileTimeoutSeconds: 7200 });
      }).toThrow(/too long|max/i);
    });
  });
});

describe('validateFileExtension', () => {
  
  describe('✅ Valid Extensions', () => {
    it('should accept common extensions', () => {
      expect(() => validateFileExtension('.csv')).not.toThrow();
      expect(() => validateFileExtension('.zip')).not.toThrow();
      expect(() => validateFileExtension('.pdf')).not.toThrow();
    });

    it('should accept extensions with hyphens', () => {
      expect(() => validateFileExtension('.my-archive')).not.toThrow();
    });
  });

  describe('❌ Invalid Extensions', () => {
    it('should reject extensions without dot', () => {
      expect(() => validateFileExtension('csv')).toThrow(/dot/i);
    });

    it('should reject empty extensions', () => {
      expect(() => validateFileExtension('')).toThrow();
    });

    it('should reject null extensions', () => {
      expect(() => validateFileExtension(null)).toThrow();
    });

    it('should reject extensions with special characters', () => {
      expect(() => validateFileExtension('.csv;rm')).toThrow();
    });

    it('should reject multi-dot extensions', () => {
      expect(() => validateFileExtension('.tar.gz')).toThrow();
    });

    it('should reject very long extensions', () => {
      const longExt = '.' + 'a'.repeat(100);
      expect(() => validateFileExtension(longExt)).toThrow();
    });
  });
});

describe('validateGlobPattern', () => {
  
  describe('✅ Valid Patterns', () => {
    it('should accept simple wildcards', () => {
      expect(() => validateGlobPattern('*.csv')).not.toThrow();
    });

    it('should accept ? wildcards', () => {
      expect(() => validateGlobPattern('report_?.csv')).not.toThrow();
    });

    it('should accept complex patterns', () => {
      expect(() => validateGlobPattern('report_[0-9]*.csv')).not.toThrow();
    });
  });

  describe('❌ Invalid Patterns', () => {
    it('should reject patterns with command injection', () => {
      expect(() => validateGlobPattern('*.csv && rm /etc/passwd')).toThrow();
    });

    it('should reject null patterns', () => {
      expect(() => validateGlobPattern(null)).toThrow();
    });

    it('should reject empty patterns', () => {
      expect(() => validateGlobPattern('')).toThrow();
    });
  });
});

describe('validateSftpCredential', () => {
  
  describe('✅ Valid Credentials', () => {
    it('should accept credential with valid host', () => {
      expect(() => {
        validateSftpCredential({ host: 'sftp.example.com' });
      }).not.toThrow();
    });

    it('should accept credential with port', () => {
      expect(() => {
        validateSftpCredential({ host: 'sftp.example.com', port: 22 });
      }).not.toThrow();
    });

    it('should accept credential with high port', () => {
      expect(() => {
        validateSftpCredential({ host: 'sftp.example.com', port: 65535 });
      }).not.toThrow();
    });
  });

  describe('❌ Invalid Credentials', () => {
    it('should reject null credential', () => {
      expect(() => validateSftpCredential(null)).toThrow();
    });

    it('should reject credential without host', () => {
      expect(() => validateSftpCredential({})).toThrow();
    });

    it('should reject credential with invalid port', () => {
      expect(() => {
        validateSftpCredential({ host: 'sftp.example.com', port: 99999 });
      }).toThrow(/port/i);
    });

    it('should reject credential with port 0', () => {
      expect(() => {
        validateSftpCredential({ host: 'sftp.example.com', port: 0 });
      }).toThrow(/port/i);
    });
  });
});

describe('validateNoCredentialsInParameters', () => {
  
  it('should allow normal parameters', () => {
    expect(() => {
      validateNoCredentialsInParameters({
        remoteDirectory: '/exports',
        downloadMode: 'all',
      });
    }).not.toThrow();
  });

  it('should reject parameters with password', () => {
    expect(() => {
      validateNoCredentialsInParameters({
        remoteDirectory: '/exports',
        password: 'secret123',
      });
    }).toThrow(/password|credential/i);
  });

  it('should reject parameters with privateKey', () => {
    expect(() => {
      validateNoCredentialsInParameters({
        remoteDirectory: '/exports',
        privateKey: 'BEGIN RSA...',
      });
    }).toThrow(/privateKey|credential/i);
  });
});

describe('validateDownloadParameters', () => {
  
  describe('✅ Valid Parameters', () => {
    it('should accept valid all-mode parameters', () => {
      expect(() => {
        validateDownloadParameters({
          remoteDirectory: '/exports/reports',
          downloadMode: 'all',
        });
      }).not.toThrow();
    });

    it('should accept valid extension-filter parameters', () => {
      expect(() => {
        validateDownloadParameters({
          remoteDirectory: '/exports/reports',
          downloadMode: 'filtered',
          filterType: 'extension',
          fileExtension: '.csv',
        });
      }).not.toThrow();
    });
  });

  describe('❌ Invalid Parameters', () => {
    it('should reject missing remoteDirectory', () => {
      expect(() => {
        validateDownloadParameters({
          downloadMode: 'all',
        });
      }).toThrow();
    });

    it('should reject invalid downloadMode', () => {
      expect(() => {
        validateDownloadParameters({
          remoteDirectory: '/exports',
          downloadMode: 'invalid',
        });
      }).toThrow(/downloadMode/i);
    });

    it('should reject filtered mode without filterType', () => {
      expect(() => {
        validateDownloadParameters({
          remoteDirectory: '/exports',
          downloadMode: 'filtered',
        });
      }).toThrow(/filterType/i);
    });
  });
});
