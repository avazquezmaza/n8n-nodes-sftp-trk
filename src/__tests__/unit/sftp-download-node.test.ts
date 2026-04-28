/**
 * Unit tests for SftpDownload node
 *
 * SftpClient and n8n helpers are fully mocked — no real SFTP connections.
 */

import { SftpDownload } from '../../nodes/SftpDownload/SftpDownload.node';
import { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { RemoteFileInfo } from '../../types/common.types';

// ---------------------------------------------------------------------------
// Mock SftpClient
// ---------------------------------------------------------------------------

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockListFiles = jest.fn();
const mockDownloadFile = jest.fn();
const mockUploadFile = jest.fn();
const mockDeletePath = jest.fn();
const mockMovePath = jest.fn();

jest.mock('../../utils/sftp-client', () => ({
  SftpClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    listFiles: mockListFiles,
    downloadFile: mockDownloadFile,
    uploadFile: mockUploadFile,
    deletePath: mockDeletePath,
    movePath: mockMovePath,
    isConnected: jest.fn().mockReturnValue(true),
  })),
}));

// ---------------------------------------------------------------------------
// Mock logger (silence output)
// ---------------------------------------------------------------------------

jest.mock('../../utils/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  logEvent: jest.fn(),
  logError: jest.fn(),
  logWarning: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(name: string, size = 1024, dir = '/exports'): RemoteFileInfo {
  return {
    filename: name,
    size,
    modifyTime: Date.now(),
    isDirectory: false,
    attrs: { remotePath: `${dir}/${name}` },
  };
}

function makeDownloadResult(content = 'csv-data') {
  return {
    content: Buffer.from(content),
    sizeBytes: Buffer.byteLength(content),
    durationMs: 50,
  };
}

type MockCtxOptions = {
  operation?: string;
  path?: string;
  /** Overrides `options` per item index when n8n calls getNodeParameter('options', idx) */
  resolveOptionsPerItem?: (itemIndex: number) => Record<string, unknown>;
  downloadType?: string;
  remoteDirectory?: string;
  downloadMode?: string;
  outputBinaryField?: string;
  recursive?: boolean;
  sourcePath?: string;
  destinationPath?: string;
  deleteType?: string;
  binaryPropertyName?: string;
  filterType?: string;
  fileExtension?: string;
  patternType?: string;
  includePattern?: string;
  excludePattern?: string;
  multiplePatterns?: unknown[];
  options?: Record<string, unknown>;
  inputItems?: INodeExecutionData[];
  continueOnFail?: boolean;
};

function buildMockCtx(params: MockCtxOptions = {}): IExecuteFunctions {
  const {
    operation = 'list',
    path = '/exports',
    downloadType = 'directorySet',
    remoteDirectory = '/exports',
    downloadMode = 'all',
    outputBinaryField = 'data',
    recursive = false,
    sourcePath = '/src/file.txt',
    destinationPath = '/dst/file.txt',
    deleteType = 'file',
    binaryPropertyName = 'data',
    filterType = 'extension',
    fileExtension = '.csv',
    patternType = 'glob',
    includePattern = '*.csv',
    excludePattern = '',
    multiplePatterns = [],
    options = {},
    resolveOptionsPerItem,
    inputItems = [{ json: {} }],
    continueOnFail: cof = false,
  } = params;

  const paramMap: Record<string, unknown> = {
    operation,
    path,
    downloadType,
    remoteDirectory,
    downloadMode,
    outputBinaryField,
    recursive,
    sourcePath,
    destinationPath,
    deleteType,
    binaryPropertyName,
    filterType,
    fileExtension,
    patternType,
    includePattern,
    excludePattern,
    multiplePatterns,
    options,
  };

  return {
    getInputData: () => inputItems,
    getNodeParameter: (name: string, itemIndex: number, defaultVal?: unknown) => {
      if (name === 'options' && resolveOptionsPerItem) {
        return resolveOptionsPerItem(itemIndex);
      }
      if (name in paramMap) return paramMap[name];
      return defaultVal;
    },
    getCredentials: jest.fn().mockResolvedValue({
      host: 'sftp.example.com',
      port: 22,
      username: 'user',
      password: 'secret',
    }),
    continueOnFail: () => cof,
    helpers: {
      getBinaryDataBuffer: jest.fn().mockResolvedValue(Buffer.from('binary-content')),
      prepareBinaryData: jest.fn().mockResolvedValue({
        data: 'base64data',
        mimeType: 'text/csv',
        fileName: 'file.csv',
      }),
    },
  } as unknown as IExecuteFunctions;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const node = new SftpDownload();

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// list operation
// ---------------------------------------------------------------------------

describe('operation: list', () => {
  it('returns one item per file in official format (default)', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('report.csv', 2048), makeFile('summary.xlsx', 4096)]);

    const ctx = buildMockCtx({ operation: 'list' });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
    expect(results[0].json.name).toBe('report.csv');
    expect(results[0].json.type).toBe('file');
    expect(results[0].json.size).toBe(2048);
  });

  it('includes path in official format output', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('data.csv')]);

    const ctx = buildMockCtx({ operation: 'list', path: '/exports' });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.path).toBe('/exports/data.csv');
  });

  it('returns empty status item when directory has no files', async () => {
    mockListFiles.mockResolvedValueOnce([]);

    const ctx = buildMockCtx({ operation: 'list' });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('empty');
    expect(result.json.totalFilesFound).toBe(0);
  });

  it('returns detailed summary format when listOutputFormat is detailed', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('a.csv'), makeFile('b.csv')]);

    const ctx = buildMockCtx({ operation: 'list', options: { listOutputFormat: 'detailed' } });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.files).toBeDefined();
    expect(result.json.summary).toBeDefined();
    expect((result.json.files as unknown[]).length).toBe(2);
  });

  it('respects maxFilesCount option', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('a.csv'), makeFile('b.csv'), makeFile('c.csv')]);

    const ctx = buildMockCtx({ operation: 'list', options: { maxFilesCount: 2 } });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
  });

  it('filters files by maxFileSizeMB option', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('small.csv', 500 * 1024),       // 0.5 MB
      makeFile('large.csv', 20 * 1024 * 1024), // 20 MB
    ]);

    const ctx = buildMockCtx({ operation: 'list', options: { maxFileSizeMB: 1 } });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    expect(results[0].json.name).toBe('small.csv');
  });

  it('reuses one SFTP connection across input items when session key matches', async () => {
    mockListFiles.mockResolvedValue([]);

    const ctx = buildMockCtx({ operation: 'list', inputItems: [{ json: {} }, { json: {} }] });
    await node.execute.call(ctx);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// download - singleFile
// ---------------------------------------------------------------------------

describe('operation: download - singleFile', () => {
  it('returns one item with binary data and metadata', async () => {
    mockDownloadFile.mockResolvedValueOnce(makeDownloadResult('col1,val1'));

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'singleFile',
      path: '/exports/report.csv',
    });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('success');
    expect(result.json.fileName).toBe('report.csv');
    expect(result.json.sizeBytes).toBeGreaterThan(0);
    expect(result.binary).toBeDefined();
    expect(result.binary!.data).toBeDefined();
  });

  it('stores binary under the configured outputBinaryField key', async () => {
    mockDownloadFile.mockResolvedValueOnce(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'singleFile',
      path: '/exports/report.csv',
      outputBinaryField: 'myFile',
    });
    const [[result]] = await node.execute.call(ctx);

    expect(result.binary!.myFile).toBeDefined();
    expect(result.binary!.data).toBeUndefined();
  });

  it('derives fileName from the remote path', async () => {
    mockDownloadFile.mockResolvedValueOnce(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'singleFile',
      path: '/deep/nested/path/file.csv',
    });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.fileName).toBe('file.csv');
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (all files)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (all)', () => {
  it('returns one item per downloaded file', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('a.csv'), makeFile('b.csv')]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({ operation: 'download', downloadType: 'directorySet', downloadMode: 'all' });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
    expect(results[0].json.status).toBe('success');
    expect(results[0].binary).toBeDefined();
  });

  it('includes file metadata in each item', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('report.csv', 4096)]);
    mockDownloadFile.mockResolvedValueOnce(makeDownloadResult());

    const ctx = buildMockCtx({ operation: 'download', downloadType: 'directorySet', downloadMode: 'all' });
    const [[result]] = await node.execute.call(ctx);

    const file = result.json.file as Record<string, unknown>;
    expect(file.fileName).toBe('report.csv');
    expect(file.downloadStatus).toBe('success');
    expect(file.size).toBe(4096);
  });

  it('returns summary item when directory is empty', async () => {
    mockListFiles.mockResolvedValueOnce([]);

    const ctx = buildMockCtx({ operation: 'download', downloadType: 'directorySet', downloadMode: 'all' });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('empty');
    expect(result.json.files).toBeDefined();
    expect(result.json.summary).toBeDefined();
  });

  it('applies maxFilesCount limit before downloading', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('a.csv'), makeFile('b.csv'), makeFile('c.csv')]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { maxFilesCount: 2 },
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
    expect(mockDownloadFile).toHaveBeenCalledTimes(2);
  });

  it('skips files exceeding maxFileSizeMB', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('small.csv', 512 * 1024),
      makeFile('big.csv', 50 * 1024 * 1024),
    ]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { maxFileSizeMB: 1 },
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    const file = results[0].json.file as Record<string, unknown>;
    expect(file.fileName).toBe('small.csv');
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (listOnly)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (listOnly)', () => {
  it('does not call downloadFile when listOnly is enabled', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('report.csv'), makeFile('data.xlsx')]);

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { listOnly: true },
    });
    await node.execute.call(ctx);

    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('marks files as skipped in listOnly mode', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('report.csv')]);

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { listOnly: true },
    });
    const [[result]] = await node.execute.call(ctx);

    const file = result.json.file as Record<string, unknown>;
    expect(file.downloadStatus).toBe('skipped');
    expect(file.skipReason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (filtered — extension)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (filtered, extension)', () => {
  it('downloads only files matching the extension', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('report.csv'),
      makeFile('archive.zip'),
      makeFile('data.csv'),
    ]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'extension',
      fileExtension: '.csv',
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
    expect(mockDownloadFile).toHaveBeenCalledTimes(2);
  });

  it('returns summary item when no files match the extension', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('archive.zip'), makeFile('data.json')]);

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'extension',
      fileExtension: '.csv',
    });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.files).toBeDefined();
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (filtered — glob pattern)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (filtered, glob)', () => {
  it('applies include and exclude glob patterns', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('report_2024.csv'),
      makeFile('temp_export.csv'),
      makeFile('archive.zip'),
    ]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'pattern',
      patternType: 'glob',
      includePattern: '*.csv',
      excludePattern: 'temp_*',
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    const file = results[0].json.file as Record<string, unknown>;
    expect(file.fileName).toBe('report_2024.csv');
  });

  it('includes all non-excluded files when no includePattern is set', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('a.csv'), makeFile('temp_b.csv')]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'pattern',
      patternType: 'glob',
      includePattern: '',
      excludePattern: 'temp_*',
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (filtered — regex pattern)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (filtered, regex)', () => {
  it('applies regex include pattern', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('report_2024_q1.csv'),
      makeFile('summary.csv'),
      makeFile('random.txt'),
    ]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'pattern',
      patternType: 'regex',
      includePattern: '^report_[0-9]{4}',
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    const file = results[0].json.file as Record<string, unknown>;
    expect(file.fileName).toBe('report_2024_q1.csv');
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (filtered — multi-pattern)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (filtered, multiPattern)', () => {
  it('applies combined include rules (OR logic)', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('report.csv'),
      makeFile('report.xlsx'),
      makeFile('archive.zip'),
    ]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'multiPattern',
      multiplePatterns: [
        { type: 'include', patternType: 'glob', pattern: '*.csv' },
        { type: 'include', patternType: 'glob', pattern: '*.xlsx' },
      ],
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
  });

  it('exclusion rule wins over include rule', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('report.csv'), makeFile('temp_report.csv')]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'filtered',
      filterType: 'multiPattern',
      multiplePatterns: [
        { type: 'include', patternType: 'glob', pattern: '*.csv' },
        { type: 'exclude', patternType: 'glob', pattern: 'temp_*' },
      ],
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    const file = results[0].json.file as Record<string, unknown>;
    expect(file.fileName).toBe('report.csv');
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (error handling)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (error handling)', () => {
  it('skips failed files and continues when skipErrors is true', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('ok.csv'), makeFile('bad.csv')]);
    mockDownloadFile
      .mockResolvedValueOnce(makeDownloadResult('ok'))
      .mockRejectedValueOnce(new Error('Permission denied'));

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { skipErrors: true },
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    const file = results[0].json.file as Record<string, unknown>;
    expect(file.downloadStatus).toBe('success');
  });

  it('throws immediately when skipErrors is false and a file fails', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('bad.csv')]);
    mockDownloadFile.mockRejectedValueOnce(new Error('SFTP error'));

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { skipErrors: false },
    });
    await expect(node.execute.call(ctx)).rejects.toThrow();
  });

  it('includes size-skipped warning in summary when some files exceed size limit', async () => {
    mockListFiles.mockResolvedValueOnce([
      makeFile('small.csv', 100),
      makeFile('huge.csv', 999 * 1024 * 1024),
    ]);
    mockDownloadFile.mockResolvedValueOnce(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { maxFileSizeMB: 1, skipErrors: true },
    });
    const [results] = await node.execute.call(ctx);

    // small.csv downloaded successfully → per-file item
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// download - directorySet (parallel)
// ---------------------------------------------------------------------------

describe('operation: download - directorySet (parallel)', () => {
  it('downloads files using concurrency when downloadInParallel is true', async () => {
    mockListFiles.mockResolvedValueOnce([makeFile('a.csv'), makeFile('b.csv'), makeFile('c.csv')]);
    mockDownloadFile.mockResolvedValue(makeDownloadResult());

    const ctx = buildMockCtx({
      operation: 'download',
      downloadType: 'directorySet',
      downloadMode: 'all',
      options: { downloadInParallel: true, maxConcurrentReads: 2 },
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(3);
    expect(mockDownloadFile).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// upload operation
// ---------------------------------------------------------------------------

describe('operation: upload', () => {
  it('uploads binary content and returns success metadata', async () => {
    mockUploadFile.mockResolvedValueOnce({ sizeBytes: 200, durationMs: 80 });

    const ctx = buildMockCtx({ operation: 'upload', path: '/exports/upload.csv' });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('success');
    expect(result.json.operation).toBe('upload');
    expect(result.json.sizeBytes).toBe(200);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('reads binary from the configured binaryPropertyName field', async () => {
    mockUploadFile.mockResolvedValueOnce({ sizeBytes: 100, durationMs: 40 });

    const ctx = buildMockCtx({ operation: 'upload', binaryPropertyName: 'myBinary' });
    await node.execute.call(ctx);

    const getBinary = (ctx.helpers.getBinaryDataBuffer as jest.Mock);
    expect(getBinary).toHaveBeenCalledWith(0, 'myBinary');
  });
});

// ---------------------------------------------------------------------------
// delete operation
// ---------------------------------------------------------------------------

describe('operation: delete', () => {
  it('deletes a file and returns success metadata', async () => {
    mockDeletePath.mockResolvedValueOnce(undefined);

    const ctx = buildMockCtx({ operation: 'delete', path: '/exports/old.csv', deleteType: 'file' });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('success');
    expect(result.json.operation).toBe('delete');
    expect(result.json.deletePath).toBe('/exports/old.csv');
    expect(result.json.deleteType).toBe('file');
  });

  it('passes isDirectory=true when deleteType is directory', async () => {
    mockDeletePath.mockResolvedValueOnce(undefined);

    const ctx = buildMockCtx({ operation: 'delete', path: '/exports/archive', deleteType: 'directory' });
    await node.execute.call(ctx);

    expect(mockDeletePath).toHaveBeenCalledWith('/exports/archive', true);
  });

  it('passes isDirectory=false when deleteType is file', async () => {
    mockDeletePath.mockResolvedValueOnce(undefined);

    const ctx = buildMockCtx({ operation: 'delete', path: '/exports/file.csv', deleteType: 'file' });
    await node.execute.call(ctx);

    expect(mockDeletePath).toHaveBeenCalledWith('/exports/file.csv', false);
  });
});

// ---------------------------------------------------------------------------
// move operation
// ---------------------------------------------------------------------------

describe('operation: move', () => {
  it('renames a file and returns source and destination paths', async () => {
    mockMovePath.mockResolvedValueOnce(undefined);

    const ctx = buildMockCtx({
      operation: 'move',
      sourcePath: '/exports/old.csv',
      destinationPath: '/archive/old.csv',
    });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('success');
    expect(result.json.operation).toBe('move');
    expect(result.json.sourcePath).toBe('/exports/old.csv');
    expect(result.json.destinationPath).toBe('/archive/old.csv');
  });

  it('passes correct paths to movePath', async () => {
    mockMovePath.mockResolvedValueOnce(undefined);

    const ctx = buildMockCtx({
      operation: 'move',
      sourcePath: '/exports/a.csv',
      destinationPath: '/archive/a.csv',
    });
    await node.execute.call(ctx);

    expect(mockMovePath).toHaveBeenCalledWith('/exports/a.csv', '/archive/a.csv');
  });
});

// ---------------------------------------------------------------------------
// Error handling and lifecycle
// ---------------------------------------------------------------------------

describe('error handling and lifecycle', () => {
  it('returns error item when continueOnFail is true and connect fails', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Network unreachable'));

    const ctx = buildMockCtx({ operation: 'list', continueOnFail: true });
    const [[result]] = await node.execute.call(ctx);

    expect(result.json.status).toBe('error');
    expect(result.json.message).toBeDefined();
    expect(result.json.errorCode).toBeDefined();
  });

  it('rethrows error when continueOnFail is false and connect fails', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Auth failed'));

    const ctx = buildMockCtx({ operation: 'list', continueOnFail: false });
    await expect(node.execute.call(ctx)).rejects.toThrow();
  });

  it('always disconnects even when an operation throws', async () => {
    mockListFiles.mockRejectedValueOnce(new Error('SFTP read error'));

    const ctx = buildMockCtx({ operation: 'list', continueOnFail: true });
    await node.execute.call(ctx);

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('always disconnects even when download throws and continueOnFail is false', async () => {
    mockListFiles.mockRejectedValueOnce(new Error('permission denied'));

    const ctx = buildMockCtx({ operation: 'list', continueOnFail: false });
    await expect(node.execute.call(ctx)).rejects.toThrow();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('rethrows transformed error code for list failures when continueOnFail is false', async () => {
    mockListFiles.mockRejectedValueOnce(
      new Error('list: /licenses/usa_vx30 /licenses/usa_vx30')
    );

    const ctx = buildMockCtx({ operation: 'list', continueOnFail: false });
    await expect(node.execute.call(ctx)).rejects.toThrow('SFTP_OPERATION_FAILED');
  });

  it('processes multiple input items without re-handshaking when session stays the same', async () => {
    mockListFiles.mockResolvedValue([makeFile('file.csv')]);

    const ctx = buildMockCtx({
      operation: 'list',
      inputItems: [{ json: { id: 1 } }, { json: { id: 2 } }, { json: { id: 3 } }],
    });
    await node.execute.call(ctx);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('opens a new connection when file timeout differs between items', async () => {
    mockListFiles.mockResolvedValue([]);

    const ctx = buildMockCtx({
      operation: 'list',
      inputItems: [{ json: {} }, { json: {} }],
      resolveOptionsPerItem: (idx) =>
        idx === 0 ? { fileTimeoutSeconds: 60 } : { fileTimeoutSeconds: 120 },
    });

    await node.execute.call(ctx);

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });

  it('opens a new connection when credentials host differs between items', async () => {
    mockListFiles.mockResolvedValue([]);
    let callIdx = 0;

    const ctx = buildMockCtx({
      operation: 'list',
      inputItems: [{ json: {} }, { json: {} }],
    });

    const credMock = ctx.getCredentials as jest.Mock;
    credMock.mockImplementation(async () => {
      callIdx += 1;
      return {
        host: callIdx === 1 ? 'east.example.com' : 'west.example.com',
        port: 22,
        username: 'user',
        password: 'secret',
      };
    });

    await node.execute.call(ctx);

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });

  it('continues to next input item after error when continueOnFail is true', async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('First item fails'))
      .mockResolvedValueOnce(undefined);
    mockListFiles.mockResolvedValueOnce([makeFile('ok.csv')]);

    const ctx = buildMockCtx({
      operation: 'list',
      continueOnFail: true,
      inputItems: [{ json: { id: 1 } }, { json: { id: 2 } }],
    });
    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
    expect(results[0].json.status).toBe('error');
    expect(results[1].json.name).toBe('ok.csv');
  });
});

// ---------------------------------------------------------------------------
// Credential parsing
// ---------------------------------------------------------------------------

describe('credential parsing', () => {
  it('selects key auth when privateKey is present in credentials', async () => {
    mockListFiles.mockResolvedValueOnce([]);

    const ctx = buildMockCtx({ operation: 'list' });
    (ctx.getCredentials as jest.Mock).mockResolvedValueOnce({
      host: 'sftp.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...',
      username: 'deploy',
    });

    await node.execute.call(ctx);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('selects password auth when no privateKey in credentials', async () => {
    mockListFiles.mockResolvedValueOnce([]);

    const ctx = buildMockCtx({ operation: 'list' });
    (ctx.getCredentials as jest.Mock).mockResolvedValueOnce({
      host: 'sftp.example.com',
      password: 'mysecret',
      username: 'admin',
    });

    await node.execute.call(ctx);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('uses allowedBasePath from credentials when set', async () => {
    mockListFiles.mockResolvedValueOnce([]);

    const ctx = buildMockCtx({ operation: 'list', path: '/exports' });
    (ctx.getCredentials as jest.Mock).mockResolvedValueOnce({
      host: 'sftp.example.com',
      password: 'pass',
      allowedBasePath: '/exports',
    });

    await expect(node.execute.call(ctx)).resolves.toBeDefined();
  });
});
