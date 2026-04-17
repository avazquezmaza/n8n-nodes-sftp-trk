/**
 * sftp-client.ts
 *
 * Secure wrapper over ssh2-sftp-client that provides:
 * - Connection lifecycle management (connect / disconnect)
 * - Remote file listing
 * - File download with per-file timeout
 * - Automatic retries for connection failures
 * - Structured logging WITHOUT exposing credentials
 * - Technical error mapping to internal error codes
 */

import SftpClientLib from 'ssh2-sftp-client';
import * as path from 'path';
import {
  SftpCredential,
  RemoteFileInfo,
  ErrorCode,
} from '../types/common.types';
import { getLogger, logEvent, logError } from './logger';
import { LogEvent } from '../types/common.types';
import { transformError } from './error-handler';

/** Casts an unknown thrown value to Error | string for transformError */
function toError(err: unknown): Error | string {
  if (err instanceof Error) return err;
  return String(err);
}
import { validateRemotePath, validateSftpCredential } from './validators';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_FILE_TIMEOUT_MS = 120_000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_BASE_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SftpClientOptions {
  /** Timeout for the initial connection in milliseconds (default: 30 000) */
  connectTimeoutMs?: number;
  /** Timeout for an individual file transfer in milliseconds (default: 120 000) */
  fileTimeoutMs?: number;
  /** Number of connection-retry attempts before giving up (default: 3) */
  maxRetries?: number;
  /** Base delay between retries in milliseconds — doubles each attempt (default: 1 000) */
  retryDelayMs?: number;
}

export interface ListFilesOptions {
  /** Include sub-directory names in the result (default: false) */
  includeDirectories?: boolean;
  /** Recursively enumerate sub-directories (default: false) */
  recursive?: boolean;
  /** Maximum total number of entries to return (0 = unlimited) */
  maxEntries?: number;
}

export interface DownloadResult {
  /** Buffer with the raw file content */
  content: Buffer;
  /** Byte length of the downloaded file */
  sizeBytes: number;
  /** Wall-clock duration of the download in milliseconds */
  durationMs: number;
}

export interface UploadResult {
  /** Byte length of the uploaded content */
  sizeBytes: number;
  /** Wall-clock duration of the upload in milliseconds */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Constructs a safe SSH connection config from our internal credential type.
 * Port defaults to 22 when absent or invalid.
 * NEVER logs this object — it contains sensitive fields.
 */
function buildConnectConfig(
  credential: SftpCredential,
  timeoutMs: number
): Record<string, unknown> {
  const port = credential.port && credential.port > 0 ? credential.port : 22;

  const config: Record<string, unknown> = {
    host: credential.host,
    port,
    username: credential.username ?? 'anonymous',
    readyTimeout: timeoutMs,
    retries: 1, // we handle retries ourselves
  };

  if (credential.authMethod === 'key' && credential.privateKey) {
    config.privateKey = credential.privateKey;
    if (credential.passphrase) {
      config.passphrase = credential.passphrase;
    }
  } else if (credential.password) {
    config.password = credential.password;
  }

  return config;
}

// ---------------------------------------------------------------------------
// SftpClient
// ---------------------------------------------------------------------------

/**
 * Thread-safe (single-use) SFTP client wrapper.
 *
 * Usage:
 * ```ts
 * const client = new SftpClient(credential, options);
 * await client.connect();
 * const files = await client.listFiles('/exports');
 * const result = await client.downloadFile('/exports/report.csv');
 * await client.disconnect();
 * ```
 */
export class SftpClient {
  private readonly client: SftpClientLib;
  private readonly options: Required<SftpClientOptions>;
  private readonly allowedBasePath: string;
  private connected = false;

  constructor(
    private readonly credential: SftpCredential,
    options: SftpClientOptions = {}
  ) {
    this.client = new SftpClientLib();
    this.allowedBasePath =
      typeof credential.allowedBasePath === 'string' && credential.allowedBasePath.trim().startsWith('/')
        ? credential.allowedBasePath.trim()
        : '/';
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      fileTimeoutMs: options.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? MAX_RETRY_ATTEMPTS,
      retryDelayMs: options.retryDelayMs ?? RETRY_DELAY_BASE_MS,
    };
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  /**
   * Establishes the SFTP session with automatic retries.
   * Validates the credential shape before attempting any network call.
   *
   * @throws if the credential is malformed OR all retry attempts fail.
   */
  async connect(): Promise<void> {
    // Validate credential shape (throws on invalid input)
    validateSftpCredential(this.credential);

    const logger = getLogger();
    logEvent(logger, {
      event: LogEvent.CONNECTION_STARTED,
      serverHostname: this.credential.host,
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        const config = buildConnectConfig(
          this.credential,
          this.options.connectTimeoutMs
        );

        await this.client.connect(config as Parameters<SftpClientLib['connect']>[0]);
        this.connected = true;

        logEvent(logger, {
          event: LogEvent.CONNECTION_ESTABLISHED,
          serverHostname: this.credential.host,
        });
        return;
      } catch (err: unknown) {
        lastError = err;

        const structured = transformError(toError(err));
        logger.warn(
          { attempt, maxRetries: this.options.maxRetries, errorCode: structured.errorCode },
          `SFTP connection attempt ${attempt} failed`
        );

        if (attempt < this.options.maxRetries) {
          const delay = this.options.retryDelayMs * 2 ** (attempt - 1);
          await sleep(delay);
        }
      }
    }

    const structured = transformError(toError(lastError));
    const connLogger = getLogger();
    logError(connLogger, structured.errorCode, structured.message, { serverHostname: this.credential.host });

    throw new Error(
      `${structured.errorCode}: ${structured.message}`
    );
  }

  // -------------------------------------------------------------------------
  // listFiles
  // -------------------------------------------------------------------------

  /**
   * Returns the list of *file* entries in a remote directory.
   * Directories are excluded by default.
   *
   * @param remotePath - Absolute path on the SFTP server.
   * @param opts       - Listing options.
   *
   * @throws if not connected, if `remotePath` fails security validation, or
   *         on any SFTP error.
   */
  async listFiles(
    remotePath: string,
    opts: ListFilesOptions = {}
  ): Promise<RemoteFileInfo[]> {
    this.assertConnected();

    // Security validation — rejects path traversal attempts
    validateRemotePath(remotePath, this.allowedBasePath);

    const logger = getLogger();
    logger.debug({ remoteDirectory: remotePath, event: LogEvent.FILE_LISTED }, 'Listing remote directory');

    const results: RemoteFileInfo[] = [];
    await this.listRecursive(remotePath, opts, results);

    if (opts.maxEntries && opts.maxEntries > 0) {
      results.splice(opts.maxEntries);
    }

    logEvent(logger, {
      event: LogEvent.FILE_LISTED,
      remoteDirectory: remotePath,
      fileCount: results.length,
    });

    return results;
  }

  /** Recursive helper that appends entries to `acc`. */
  private async listRecursive(
    dir: string,
    opts: ListFilesOptions,
    acc: RemoteFileInfo[]
  ): Promise<void> {
    if (opts.maxEntries && opts.maxEntries > 0 && acc.length >= opts.maxEntries) {
      return;
    }

    let entries: SftpClientLib.FileInfo[];

    try {
      entries = await this.client.list(dir);
    } catch (err: unknown) {
      const structured = transformError(toError(err));
      throw new Error(`${structured.errorCode}: ${structured.message}`);
    }

    for (const entry of entries) {
      if (opts.maxEntries && opts.maxEntries > 0 && acc.length >= opts.maxEntries) {
        return;
      }

      const isDir = entry.type === 'd';

      if (isDir) {
        if (opts.includeDirectories) {
          acc.push(this.toRemoteFileInfo(entry, dir));
        }
        if (opts.recursive) {
          const subDir = `${dir}/${entry.name}`;
          await this.listRecursive(subDir, opts, acc);

          if (opts.maxEntries && opts.maxEntries > 0 && acc.length >= opts.maxEntries) {
            return;
          }
        }
      } else {
        acc.push(this.toRemoteFileInfo(entry, dir));
      }
    }
  }

  private toRemoteFileInfo(entry: SftpClientLib.FileInfo, parentDir: string): RemoteFileInfo {
    const remotePath = path.posix.join(parentDir, entry.name);

    return {
      filename: entry.name,
      size: entry.size,
      modifyTime: entry.modifyTime,
      isDirectory: entry.type === 'd',
      longname: (entry as unknown as { longname?: string }).longname,
      attrs: {
        remotePath,
      },
    };
  }

  // -------------------------------------------------------------------------
  // downloadFile
  // -------------------------------------------------------------------------

  /**
   * Downloads a single remote file into memory.
   *
   * @param remotePath - Full remote path (directory + filename).
   * @returns `DownloadResult` with the raw Buffer, byte size and duration.
   *
   * @throws on path validation failure, timeout, or SFTP error.
   */
  async downloadFile(remotePath: string): Promise<DownloadResult> {
    this.assertConnected();

    // Security: validate each path before attempting download
    const parentDir = path.dirname(remotePath);
    validateRemotePath(parentDir, this.allowedBasePath);

    const filename = path.basename(remotePath);
    const dlLogger = getLogger();
    logEvent(dlLogger, { event: LogEvent.FILE_DOWNLOAD_STARTED, fileName: filename });
    const startTime = Date.now();

    let content: Buffer;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Timed out: Download timed out for ${filename}`)), this.options.fileTimeoutMs);
        timeoutHandle.unref?.();
      });

      content = await Promise.race([
        this.client.get(remotePath) as Promise<Buffer>,
        timeoutPromise,
      ]);
    } catch (err: unknown) {
      const errStructured = transformError(toError(err));
      logError(getLogger(), errStructured.errorCode, errStructured.message, { fileName: filename });
      const structured = errStructured;
      throw new Error(`${structured.errorCode}: ${structured.message}`);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    const durationMs = Date.now() - startTime;

    // Ensure `content` is a proper Buffer (ssh2-sftp-client can return a
    // writable stream or Buffer depending on options; with no dst arg it
    // returns Buffer).
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));

    logEvent(dlLogger, {
      event: LogEvent.FILE_DOWNLOAD_COMPLETED,
      fileName: filename,
      fileSize: buf.length,
      durationMs,
    });

    dlLogger.debug(
      { fileName: filename, sizeBytes: buf.length, durationMs },
      'File downloaded'
    );

    return {
      content: buf,
      sizeBytes: buf.length,
      durationMs,
    };
  }

  // -------------------------------------------------------------------------
  // uploadFile
  // -------------------------------------------------------------------------

  /**
   * Uploads a Buffer to a remote path.
   */
  async uploadFile(remotePath: string, content: Buffer): Promise<UploadResult> {
    this.assertConnected();

    const parentDir = path.dirname(remotePath);
    validateRemotePath(parentDir, this.allowedBasePath);

    const fileName = path.basename(remotePath);
    const startTime = Date.now();

    try {
      await this.client.put(content, remotePath);
    } catch (err: unknown) {
      const structured = transformError(toError(err));
      logError(getLogger(), structured.errorCode, structured.message, { fileName });
      throw new Error(`${structured.errorCode}: ${structured.message}`);
    }

    const durationMs = Date.now() - startTime;

    logEvent(getLogger(), {
      event: LogEvent.EXECUTION_COMPLETED,
      fileName,
      fileSize: content.length,
      durationMs,
      operationName: 'uploadFile',
    });

    return {
      sizeBytes: content.length,
      durationMs,
    };
  }

  // -------------------------------------------------------------------------
  // deletePath
  // -------------------------------------------------------------------------

  /**
   * Deletes a file or directory from the remote server.
   */
  async deletePath(remotePath: string, isDirectory = false): Promise<void> {
    this.assertConnected();

    validateRemotePath(remotePath, this.allowedBasePath);

    try {
      if (isDirectory) {
        await this.client.rmdir(remotePath, true);
      } else {
        await this.client.delete(remotePath);
      }
    } catch (err: unknown) {
      const structured = transformError(toError(err));
      logError(getLogger(), structured.errorCode, structured.message, {
        filePath: remotePath,
        operationName: 'deletePath',
      });
      throw new Error(`${structured.errorCode}: ${structured.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // movePath
  // -------------------------------------------------------------------------

  /**
   * Renames or moves a remote file or directory.
   */
  async movePath(sourcePath: string, destinationPath: string): Promise<void> {
    this.assertConnected();

    validateRemotePath(sourcePath, this.allowedBasePath);
    validateRemotePath(path.dirname(destinationPath), this.allowedBasePath);

    try {
      await this.client.rename(sourcePath, destinationPath);
    } catch (err: unknown) {
      const structured = transformError(toError(err));
      logError(getLogger(), structured.errorCode, structured.message, {
        sourcePath,
        destinationPath,
        operationName: 'movePath',
      });
      throw new Error(`${structured.errorCode}: ${structured.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  /**
   * Closes the SFTP session.  Safe to call even when not connected.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.end();
    } catch {
      // Ignore errors during cleanup
    } finally {
      this.connected = false;
      logEvent(getLogger(), {
        event: LogEvent.CONNECTION_CLOSED,
        serverHostname: this.credential.host,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Returns `true` if the session is currently open. */
  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Private utilities
  // -------------------------------------------------------------------------

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error(
        `${ErrorCode.SFTP_CONNECTION_FAILED}: SFTP client is not connected. Call connect() first.`
      );
    }
  }

}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Convenience factory that creates and connects an SftpClient in one call.
 *
 * ```ts
 * const client = await createConnectedSftpClient(credential, { connectTimeoutMs: 15_000 });
 * ```
 */
export async function createConnectedSftpClient(
  credential: SftpCredential,
  options?: SftpClientOptions
): Promise<SftpClient> {
  const client = new SftpClient(credential, options);
  await client.connect();
  return client;
}
