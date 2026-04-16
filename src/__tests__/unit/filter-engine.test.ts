/**
 * Tests unitarios para FilterEngine
 */

import {
  FilterEngine,
  FilterResult,
  createExtensionFilter,
  createPatternFilter,
  createMultiPatternFilter,
  passSizeFilter,
} from '../../utils/filter-engine';
import { RemoteFileInfo } from '../../types/common.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(filename: string, size = 1024): RemoteFileInfo {
  return {
    filename,
    size,
    modifyTime: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// FilterEngine - constructor
// ---------------------------------------------------------------------------

describe('FilterEngine - constructor', () => {
  it('should create engine with no patterns', () => {
    expect(() => new FilterEngine()).not.toThrow();
    expect(() => new FilterEngine([])).not.toThrow();
  });

  it('should create engine with valid glob pattern', () => {
    expect(
      () => new FilterEngine([{ type: 'include', patternType: 'glob', pattern: '*.csv' }])
    ).not.toThrow();
  });

  it('should create engine with valid regex pattern', () => {
    expect(
      () =>
        new FilterEngine([
          { type: 'include', patternType: 'regex', pattern: '^report_[0-9]{4}' },
        ])
    ).not.toThrow();
  });

  it('should reject invalid glob pattern on construction', () => {
    expect(
      () =>
        new FilterEngine([
          { type: 'include', patternType: 'glob', pattern: '*.csv && rm -rf /' },
        ])
    ).toThrow();
  });

  it('should reject ReDoS pattern on construction', () => {
    expect(
      () =>
        new FilterEngine([{ type: 'include', patternType: 'regex', pattern: '(a+)+$' }])
    ).toThrow(/REDOS/i);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.evaluate - no rules
// ---------------------------------------------------------------------------

describe('FilterEngine.evaluate - no rules', () => {
  it('should include all files when no patterns exist', () => {
    const engine = new FilterEngine();

    expect(engine.evaluate('any.csv').included).toBe(true);
    expect(engine.evaluate('report.xlsx').included).toBe(true);
    expect(engine.evaluate('data.json').included).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.evaluate - glob inclusion
// ---------------------------------------------------------------------------

describe('FilterEngine.evaluate - glob inclusion', () => {
  const engine = new FilterEngine([
    { type: 'include', patternType: 'glob', pattern: '*.csv' },
  ]);

  it('should include .csv files', () => {
    expect(engine.evaluate('report.csv').included).toBe(true);
  });

  it('should exclude non-matching files', () => {
    expect(engine.evaluate('report.xlsx').included).toBe(false);
  });

  it('should include complex matching names', () => {
    expect(engine.evaluate('vendas_2024_q1.csv').included).toBe(true);
  });

  it('should not include files without extension when pattern needs one', () => {
    expect(engine.evaluate('no_extension').included).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.evaluate - glob exclusion
// ---------------------------------------------------------------------------

describe('FilterEngine.evaluate - glob exclusion', () => {
  const engine = new FilterEngine([
    { type: 'exclude', patternType: 'glob', pattern: '*.tmp' },
    { type: 'exclude', patternType: 'glob', pattern: '*.log' },
  ]);

  it('should exclude .tmp files', () => {
    expect(engine.evaluate('data.tmp').included).toBe(false);
  });

  it('should exclude .log files', () => {
    expect(engine.evaluate('error.log').included).toBe(false);
  });

  it('should include files not matching any exclusion', () => {
    expect(engine.evaluate('report.csv').included).toBe(true);
  });

  it('should include files not matching exclusions when no inclusions defined', () => {
    expect(engine.evaluate('archive.zip').included).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.evaluate - exclusion has priority over inclusion
// ---------------------------------------------------------------------------

describe('FilterEngine.evaluate - exclusion priority', () => {
  const engine = new FilterEngine([
    { type: 'include', patternType: 'glob', pattern: '*.csv' },
    { type: 'exclude', patternType: 'glob', pattern: 'temp_*' },
  ]);

  it('should include non-prefixed csv files', () => {
    expect(engine.evaluate('report.csv').included).toBe(true);
  });

  it('should exclude temp_ even if it matches include rule', () => {
    expect(engine.evaluate('temp_data.csv').included).toBe(false);
  });

  it('should exclude temp_ files that would otherwise not match', () => {
    expect(engine.evaluate('temp_log.txt').included).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.evaluate - regex patterns
// ---------------------------------------------------------------------------

describe('FilterEngine.evaluate - regex patterns', () => {
  const engine = new FilterEngine([
    { type: 'include', patternType: 'regex', pattern: '^report_[0-9]{4}.*\\.csv' },
  ]);

  it('should include files matching regex', () => {
    expect(engine.evaluate('report_2024_q1.csv').included).toBe(true);
  });

  it('should exclude files not matching regex', () => {
    expect(engine.evaluate('summary.csv').included).toBe(false);
    expect(engine.evaluate('report_abc.csv').included).toBe(false);
  });

  it('should apply regex exclusion', () => {
    const excEngine = new FilterEngine([
      { type: 'exclude', patternType: 'regex', pattern: '\\.(tmp|bak)' },
    ]);

    expect(excEngine.evaluate('data.tmp').included).toBe(false);
    expect(excEngine.evaluate('data.bak').included).toBe(false);
    expect(excEngine.evaluate('data.csv').included).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.evaluate - combined include + exclude different types
// ---------------------------------------------------------------------------

describe('FilterEngine.evaluate - mixed pattern types', () => {
  const engine = new FilterEngine([
    { type: 'include', patternType: 'glob', pattern: '*.csv' },
    { type: 'exclude', patternType: 'regex', pattern: '^temp' },
  ]);

  it('should include csv not starting with temp', () => {
    expect(engine.evaluate('report.csv').included).toBe(true);
  });

  it('should exclude csv starting with temp (exclusion regex wins)', () => {
    expect(engine.evaluate('temp_export.csv').included).toBe(false);
  });

  it('should exclude non-csv even if no exclusion matches', () => {
    expect(engine.evaluate('archive.zip').included).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.filter
// ---------------------------------------------------------------------------

describe('FilterEngine.filter', () => {
  const engine = new FilterEngine([
    { type: 'include', patternType: 'glob', pattern: '*.csv' },
  ]);

  const files = [
    makeFile('report.csv'),
    makeFile('data.xlsx'),
    makeFile('summary.csv'),
    makeFile('archive.zip'),
  ];

  it('should return only included files', () => {
    const result = engine.filter(files);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.filename)).toEqual(['report.csv', 'summary.csv']);
  });

  it('should return all files when no rules', () => {
    const noRules = new FilterEngine();
    expect(noRules.filter(files)).toHaveLength(4);
  });

  it('should return empty array if nothing matches', () => {
    const strictEngine = new FilterEngine([
      { type: 'include', patternType: 'glob', pattern: '*.pdf' },
    ]);
    expect(strictEngine.filter(files)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FilterEngine.summarize
// ---------------------------------------------------------------------------

describe('FilterEngine.summarize', () => {
  const engine = new FilterEngine([
    { type: 'include', patternType: 'glob', pattern: '*.csv' },
  ]);

  const files = [
    makeFile('a.csv'),
    makeFile('b.csv'),
    makeFile('c.xlsx'),
    makeFile('d.zip'),
  ];

  it('should count totals correctly', () => {
    const summary = engine.summarize(files);
    expect(summary.totalEvaluated).toBe(4);
    expect(summary.included).toBe(2);
    expect(summary.excluded).toBe(2);
  });

  it('should group included files by extension', () => {
    const summary = engine.summarize(files);
    expect(summary.byExtension['.csv']).toBe(2);
  });

  it('should handle mixed extensions', () => {
    const mixedEngine = new FilterEngine();
    const mixedFiles = [
      makeFile('a.csv'),
      makeFile('b.csv'),
      makeFile('c.xlsx'),
      makeFile('d.pdf'),
    ];
    const summary = mixedEngine.summarize(mixedFiles);
    expect(summary.byExtension['.csv']).toBe(2);
    expect(summary.byExtension['.xlsx']).toBe(1);
    expect(summary.byExtension['.pdf']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Factory: createExtensionFilter
// ---------------------------------------------------------------------------

describe('createExtensionFilter', () => {
  it('should create engine that includes files with given extension', () => {
    const engine = createExtensionFilter('.csv');
    expect(engine.evaluate('report.csv').included).toBe(true);
  });

  it('should exclude files with different extension', () => {
    const engine = createExtensionFilter('.csv');
    expect(engine.evaluate('report.xlsx').included).toBe(false);
  });

  it('should handle extension without leading dot', () => {
    const engine = createExtensionFilter('csv');
    expect(engine.evaluate('report.csv').included).toBe(true);
    expect(engine.evaluate('report.xlsx').included).toBe(false);
  });

  it('should be case-sensitive by default', () => {
    const engine = createExtensionFilter('.csv');
    expect(engine.evaluate('report.CSV').included).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory: createPatternFilter
// ---------------------------------------------------------------------------

describe('createPatternFilter', () => {
  it('should create engine with glob include only', () => {
    const engine = createPatternFilter('glob', '*.csv');
    expect(engine.evaluate('data.csv').included).toBe(true);
    expect(engine.evaluate('data.txt').included).toBe(false);
  });

  it('should create engine with glob include and exclude', () => {
    const engine = createPatternFilter('glob', '*.csv', 'temp_*');
    expect(engine.evaluate('report.csv').included).toBe(true);
    expect(engine.evaluate('temp_report.csv').included).toBe(false);
  });

  it('should create engine with regex include', () => {
    const engine = createPatternFilter('regex', '^[0-9]{4}_report');
    expect(engine.evaluate('2024_report_q1.csv').included).toBe(true);
    expect(engine.evaluate('report.csv').included).toBe(false);
  });

  it('should include all files when no patterns given', () => {
    const engine = createPatternFilter('glob');
    expect(engine.evaluate('anything.txt').included).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Factory: createMultiPatternFilter
// ---------------------------------------------------------------------------

describe('createMultiPatternFilter', () => {
  it('should apply all provided rules', () => {
    const engine = createMultiPatternFilter([
      { type: 'include', patternType: 'glob', pattern: '*.csv' },
      { type: 'include', patternType: 'glob', pattern: '*.xlsx' },
      { type: 'exclude', patternType: 'glob', pattern: 'temp_*' },
    ]);

    expect(engine.evaluate('report.csv').included).toBe(true);
    expect(engine.evaluate('report.xlsx').included).toBe(true);
    expect(engine.evaluate('temp_report.csv').included).toBe(false);
    expect(engine.evaluate('archive.zip').included).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// passSizeFilter
// ---------------------------------------------------------------------------

describe('passSizeFilter', () => {
  it('should pass files within size limit', () => {
    expect(passSizeFilter(1024 * 1024, 10)).toBe(true); // 1 MB <= 10 MB
  });

  it('should reject files exceeding limit', () => {
    expect(passSizeFilter(100 * 1024 * 1024, 10)).toBe(false); // 100 MB > 10 MB
  });

  it('should pass files exactly at limit', () => {
    const tenMB = 10 * 1024 * 1024;
    expect(passSizeFilter(tenMB, 10)).toBe(true);
  });

  it('should treat 0 limit as unlimited', () => {
    expect(passSizeFilter(999 * 1024 * 1024, 0)).toBe(true); // 999 MB with no limit
  });

  it('should handle zero-byte files', () => {
    expect(passSizeFilter(0, 10)).toBe(true);
  });

  it('should handle very large files outside limit', () => {
    const fiveGB = 5 * 1024 * 1024 * 1024;
    expect(passSizeFilter(fiveGB, 1024)).toBe(false); // 5 GB > 1024 MB
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('FilterEngine - edge cases', () => {
  it('should handle empty filename', () => {
    const engine = new FilterEngine([
      { type: 'include', patternType: 'glob', pattern: '*.csv' },
    ]);
    expect(engine.evaluate('').included).toBe(false);
  });

  it('should handle filenames with spaces', () => {
    const engine = new FilterEngine();
    expect(engine.evaluate('my report.csv').included).toBe(true);
  });

  it('should handle filenames with dots only', () => {
    const engine = new FilterEngine([
      { type: 'include', patternType: 'glob', pattern: '*.csv' },
    ]);
    expect(engine.evaluate('.hidden').included).toBe(false);
  });

  it('should handle filter of empty file list', () => {
    const engine = new FilterEngine([
      { type: 'include', patternType: 'glob', pattern: '*.csv' },
    ]);
    expect(engine.filter([])).toEqual([]);
    expect(engine.summarize([]).totalEvaluated).toBe(0);
  });

  it('should include matchedRule in result when matched', () => {
    const rule = { type: 'include' as const, patternType: 'glob' as const, pattern: '*.csv' };
    const engine = new FilterEngine([rule]);
    const result: FilterResult = engine.evaluate('report.csv');

    expect(result.matchedRule).toBeDefined();
    expect(result.matchedRule?.pattern).toBe('*.csv');
  });
});
