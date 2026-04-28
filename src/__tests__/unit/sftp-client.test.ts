/**
 * Unit tests for SftpClient
 *
 * ssh2-sftp-client is fully mocked, so no test performs real network connections.
 */

import { SftpClient, createConnectedSftpClient, SftpClientOptions } from '../../utils/sftp-client';
import { SftpCredential } from '../../types/common.types';

// ---------------------------------------------------------------------------
// Mock ssh2-sftp-client
// ---------------------------------------------------------------------------

const mockConnect = jest.fn();
const mockEnd = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();

/** When set, SftpClient uses concurrent download (downloadToBuffer) instead of get() */
let mockSftpChannel: {
  open: jest.Mock;
  fstat: jest.Mock;
  read: jest.Mock;
  close: jest.Mock;
} | null = null;

jest.mock('ssh2-sftp-client', () => {
  return jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    end: mockEnd,
    list: mockList,
    get: mockGet,
    get sftp() {
      return mockSftpChannel;
    },
  }));
});

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
  logDebug: jest.fn(),
  LogEvent: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validCredential: SftpCredential = {
  host: 'sftp.example.com',
  port: 22,
  username: 'testuser',
  password: 'secret',
  authMethod: 'password',
};

const fastOptions: SftpClientOptions = {
  connectTimeoutMs: 5_000,
  fileTimeoutMs: 5_000,
  maxRetries: 1,
  retryDelayMs: 10,
};

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

describe('SftpClient.connect()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSftpChannel = null;
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
  });

  it('should connect successfully on first attempt', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('should pass correct port to underlying library', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();

    const callArg = mockConnect.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.host).toBe('sftp.example.com');
    expect(callArg.port).toBe(22);
    expect(callArg.username).toBe('testuser');
    // Password must be passed but must NOT appear in logged data (handled by pino redaction)
    expect(callArg.password).toBe('secret');
  });

  it('should default port to 22 when not specified', async () => {
    const cred: SftpCredential = { host: 'sftp.example.com', username: 'u', password: 'p' };
    const client = new SftpClient(cred, fastOptions);
    await client.connect();
    const callArg = mockConnect.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.port).toBe(22);
  });

  it('should include AES-first cipher list and keepalive in connect config', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const callArg = mockConnect.mock.calls[0][0] as Record<string, unknown>;
    const algorithms = callArg.algorithms as { cipher: string[] };
    expect(algorithms.cipher[0]).toContain('aes');
    expect(callArg.keepaliveInterval).toBe(10_000);
  });

  it('should use privateKey when authMethod is key', async () => {
    const keyCred: SftpCredential = {
      host: 'sftp.example.com',
      username: 'u',
      privateKey: 'mock-private-key-content',
      authMethod: 'key',
    };
    const client = new SftpClient(keyCred, fastOptions);
    await client.connect();
    const callArg = mockConnect.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.privateKey).toBeDefined();
    expect(callArg.password).toBeUndefined();
  });

  it('should retry on failure and succeed on second attempt', async () => {
    const options: SftpClientOptions = { ...fastOptions, maxRetries: 3 };
    mockConnect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);

    const client = new SftpClient(validCredential, options);
    await expect(client.connect()).resolves.toBeUndefined();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(client.isConnected()).toBe(true);
  });

  it('should throw after exhausting all retries', async () => {
    const options: SftpClientOptions = { ...fastOptions, maxRetries: 2, retryDelayMs: 0 };
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new SftpClient(validCredential, options);
    await expect(client.connect()).rejects.toThrow();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(client.isConnected()).toBe(false);
  });

  it('should throw on invalid credential (empty host)', async () => {
    const badCred: SftpCredential = { host: '', username: 'u', password: 'p' };
    const client = new SftpClient(badCred, fastOptions);
    await expect(client.connect()).rejects.toThrow();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isConnected()
// ---------------------------------------------------------------------------

describe('SftpClient.isConnected()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
  });

  it('should return false before connecting', () => {
    const client = new SftpClient(validCredential, fastOptions);
    expect(client.isConnected()).toBe(false);
  });

  it('should return true after connect()', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it('should return false after disconnect()', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// disconnect()
// ---------------------------------------------------------------------------

describe('SftpClient.disconnect()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
  });

  it('should call end() when connected', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await client.disconnect();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('should be safe to call when not connected', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('should suppress errors from end()', async () => {
    mockEnd.mockRejectedValueOnce(new Error('Socket already closed'));
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listFiles()
// ---------------------------------------------------------------------------

describe('SftpClient.listFiles()', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
  });

  function makeEntry(
    name: string,
    size = 1024,
    type: 'd' | '-' = '-'
  ): object {
    return { name, size, modifyTime: Date.now(), type };
  }

  it('should throw if not connected', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await expect(client.listFiles('/exports')).rejects.toThrow(/not connected/i);
  });

  it('should return file entries from remote directory', async () => {
    mockList.mockResolvedValueOnce([
      makeEntry('report.csv', 2048),
      makeEntry('summary.xlsx', 4096),
    ]);

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const files = await client.listFiles('/exports');

    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe('report.csv');
    expect(files[1].filename).toBe('summary.xlsx');
  });

  it('should exclude directories by default', async () => {
    mockList.mockResolvedValueOnce([
      makeEntry('report.csv'),
      makeEntry('archive', 0, 'd'),
    ]);

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const files = await client.listFiles('/exports');

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('report.csv');
  });

  it('should include directories when option is set', async () => {
    mockList.mockResolvedValueOnce([
      makeEntry('report.csv'),
      makeEntry('archive', 0, 'd'),
    ]);

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const files = await client.listFiles('/exports', { includeDirectories: true });

    expect(files).toHaveLength(2);
  });

  it('should respect maxEntries limit', async () => {
    mockList.mockResolvedValueOnce([
      makeEntry('a.csv'),
      makeEntry('b.csv'),
      makeEntry('c.csv'),
    ]);

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const files = await client.listFiles('/exports', { maxEntries: 2 });

    expect(files).toHaveLength(2);
  });

  it('should enumerate sub-directories recursively', async () => {
    mockList
      .mockResolvedValueOnce([
        makeEntry('top.csv'),
        makeEntry('sub', 0, 'd'),
      ])
      .mockResolvedValueOnce([makeEntry('nested.csv')]);

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const files = await client.listFiles('/exports', { recursive: true });

    expect(files.map((f) => f.filename)).toEqual(['top.csv', 'nested.csv']);
  });

  it('should throw and map errors from the SFTP library', async () => {
    mockList.mockRejectedValueOnce(new Error('No such file'));

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await expect(client.listFiles('/exports')).rejects.toThrow();
  });

  it('should reject path traversal attempts', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    // validateRemotePath should throw on paths containing ../
    await expect(client.listFiles('/exports/../etc/passwd')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// downloadFile()
// ---------------------------------------------------------------------------

describe('SftpClient.downloadFile()', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockSftpChannel = null;
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
  });

  it('should throw if not connected', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await expect(client.downloadFile('/exports/report.csv')).rejects.toThrow(/not connected/i);
  });

  it('should return a DownloadResult with buffer and metadata', async () => {
    const fileContent = Buffer.from('col1,col2\nval1,val2');
    mockGet.mockResolvedValueOnce(fileContent);

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const result = await client.downloadFile('/exports/report.csv');

    expect(result.content).toBeInstanceOf(Buffer);
    expect(result.sizeBytes).toBe(fileContent.length);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should pass the remote path directly to library.get()', async () => {
    mockGet.mockResolvedValueOnce(Buffer.from('data'));

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await client.downloadFile('/exports/report.csv');

    expect(mockGet).toHaveBeenCalledWith('/exports/report.csv');
  });

  it('should reject on SFTP library error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Permission denied'));

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await expect(client.downloadFile('/exports/report.csv')).rejects.toThrow();
  });

  it('should reject when file download exceeds timeout', async () => {
    // Never resolves
    mockGet.mockImplementationOnce(() => new Promise(() => {}));

    const options: SftpClientOptions = { ...fastOptions, fileTimeoutMs: 50 };
    const client = new SftpClient(validCredential, options);
    await client.connect();

    await expect(client.downloadFile('/exports/large.csv')).rejects.toThrow(/TIMEOUT/i);
  }, 3000);

  it('should reject path traversal in remote path', async () => {
    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    await expect(client.downloadFile('/exports/../../etc/passwd')).rejects.toThrow();
  });

  it('should download via concurrent SFTP reads when channel is available', async () => {
    const handle = Buffer.from([1]);
    const payload = Buffer.from('hello');
    mockSftpChannel = {
      open: jest.fn((_p: string, _f: string, cb: (e: Error | null, h?: Buffer) => void) => {
        cb(null, handle);
      }),
      fstat: jest.fn((_h: Buffer, cb: (e: Error | null, s?: { size: number }) => void) => {
        cb(null, { size: payload.length });
      }),
      read: jest.fn(
        (
          _h: Buffer,
          out: Buffer,
          bufOffset: number,
          len: number,
          _pos: number,
          cb: (e: Error | null) => void
        ) => {
          payload.copy(out, bufOffset, 0, len);
          cb(null);
        }
      ),
      close: jest.fn((_h: Buffer, cb?: () => void) => {
        cb?.();
      }),
    };

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const result = await client.downloadFile('/allowed/report.csv');

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSftpChannel?.open).toHaveBeenCalled();
    expect(result.content.equals(payload)).toBe(true);
    expect(result.sizeBytes).toBe(payload.length);
  });

  it('should resolve empty file via concurrent SFTP path', async () => {
    const handle = Buffer.from([2]);
    mockSftpChannel = {
      open: jest.fn((_p: string, _f: string, cb: (e: Error | null, h?: Buffer) => void) => {
        cb(null, handle);
      }),
      fstat: jest.fn((_h: Buffer, cb: (e: Error | null, s?: { size: number }) => void) => {
        cb(null, { size: 0 });
      }),
      read: jest.fn(),
      close: jest.fn((_h: Buffer, cb?: () => void) => {
        cb?.();
      }),
    };

    const client = new SftpClient(validCredential, fastOptions);
    await client.connect();
    const result = await client.downloadFile('/allowed/empty.txt');

    expect(result.content.length).toBe(0);
    expect(mockSftpChannel?.read).not.toHaveBeenCalled();
  });

});

// ---------------------------------------------------------------------------
// createConnectedSftpClient factory
// ---------------------------------------------------------------------------

describe('createConnectedSftpClient()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
  });

  it('should return a connected client', async () => {
    const client = await createConnectedSftpClient(validCredential, fastOptions);
    expect(client.isConnected()).toBe(true);
  });

  it('should throw if underlying connect fails', async () => {
    mockConnect.mockRejectedValue(new Error('Auth fail'));
    await expect(
      createConnectedSftpClient(validCredential, { ...fastOptions, maxRetries: 1 })
    ).rejects.toThrow();
  });
});
