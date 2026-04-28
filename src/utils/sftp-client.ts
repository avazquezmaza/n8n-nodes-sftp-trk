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

/**
 * Target payload per SFTP READ. Smaller chunks (e.g. 32 KiB) mean many more
 * round trips per MiB than OpenSSH-shaped servers typically allow (~256 KiB max);
 * ssh2 splits oversized requests internally (`_maxReadLen`).
 */
const DOWNLOAD_PARALLEL_CHUNK_BYTES = 256 * 1024;

/** Concurrent overlapping READ RPCs scheduled per large file transfer. */
const DOWNLOAD_PARALLEL_RPCS = 64;

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
    retries: 1,
    // Keepalive prevents the server from dropping idle connections during parallel batch downloads
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    // Prefer AES-GCM ciphers that use hardware AES-NI acceleration over software-only chacha20
    algorithms: {
      cipher: [
        'aes128-gcm@openssh.com',
        'aes256-gcm@openssh.com',
        'aes128-ctr',
        'aes192-ctr',
        'aes256-ctr',
        'chacha20-poly1305@openssh.com',
      ],
    },
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
      // Preserve the original error class so transformError can classify it.
      // Append the directory to make the problem immediately identifiable.
      if (err instanceof Error) {
        err.message = `${err.message} (directory: ${dir})`;
        throw err;
      }
      throw new Error(`Failed to list directory ${dir}: ${String(err)}`);
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
   * Downloads a single remote file into memory. When the raw SFTP channel is
   * available, uses many overlapping READ requests and large chunks (see
   * `DOWNLOAD_PARALLEL_*` constants); otherwise falls back to the library `get()`
   * path (sequential stream), which is slower on high-latency links.
   *
   * @param remotePath    - Full remote path (directory + filename).
   * @param timeoutOverrideMs - Optional per-call timeout that overrides the
   *                            instance default set in the constructor.
   * @returns `DownloadResult` with the raw Buffer, byte size and duration.
   *
   * @throws on path validation failure, timeout, or SFTP error.
   */
  async downloadFile(remotePath: string, timeoutOverrideMs?: number): Promise<DownloadResult> {
    this.assertConnected();

    const parentDir = path.dirname(remotePath);
    validateRemotePath(parentDir, this.allowedBasePath);

    const filename = path.basename(remotePath);
    const dlLogger = getLogger();
    logEvent(dlLogger, { event: LogEvent.FILE_DOWNLOAD_STARTED, fileName: filename });
    const startTime = Date.now();
    const timeoutMs = timeoutOverrideMs ?? this.options.fileTimeoutMs;

    let content: Buffer;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Timed out: Download timed out for ${filename}`));
        }, timeoutMs);
        timeoutHandle.unref?.();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSftp = (this.client as any).sftp;
      const downloadPromise = rawSftp
        ? this.downloadToBuffer(rawSftp, remotePath)
        : (this.client.get(remotePath) as Promise<Buffer>);

      content = await Promise.race([downloadPromise, timeoutPromise]);
    } catch (err: unknown) {
      if (timedOut) {
        // Force-close so any in-flight reads are aborted
        try { await this.client.end(); } catch { /* ignore */ }
        this.connected = false;
      }
      const structured = transformError(toError(err));
      logError(getLogger(), structured.errorCode, structured.message, { fileName: filename });
      throw new Error(`${structured.errorCode}: ${structured.message}`);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const durationMs = Date.now() - startTime;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));

    logEvent(dlLogger, {
      event: LogEvent.FILE_DOWNLOAD_COMPLETED,
      fileName: filename,
      fileSize: buf.length,
      durationMs,
    });

    dlLogger.debug({ fileName: filename, sizeBytes: buf.length, durationMs }, 'File downloaded');

    return { content: buf, sizeBytes: buf.length, durationMs };
  }

  /**
   * Schedules overlapping SFTP READ calls to keep the SSH channel busy across RTT
   * (similar idea to ssh2 `fastXfer` / desktop SFTP clients with parallel reads).
   */
  private downloadToBuffer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sftp: any,
    remotePath: string,
    concurrency = DOWNLOAD_PARALLEL_RPCS,
    chunkSize = DOWNLOAD_PARALLEL_CHUNK_BYTES,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      sftp.open(remotePath, 'r', (openErr: Error | null, handle: Buffer) => {
        if (openErr) return reject(openErr);

        sftp.fstat(handle, (statErr: Error | null, stats: { size: number }) => {
          if (statErr) {
            sftp.close(handle, () => { /* ignore */ });
            return reject(statErr);
          }

          const fileSize = stats.size;

          if (fileSize === 0) {
            sftp.close(handle, () => resolve(Buffer.alloc(0)));
            return;
          }

          const output = Buffer.allocUnsafe(fileSize);
          const totalChunks = Math.ceil(fileSize / chunkSize);
          let completed = 0;
          let nextOffset = 0;
          let inFlight = 0;
          let done = false;

          function onError(err: Error) {
            if (done) return;
            done = true;
            sftp.close(handle, () => reject(err));
          }

          function scheduleReads() {
            while (inFlight < concurrency && nextOffset < fileSize) {
              const offset = nextOffset;
              const length = Math.min(chunkSize, fileSize - offset);
              nextOffset += length;
              inFlight++;

              sftp.read(
                handle,
                output,
                offset,
                length,
                offset,
                (readErr: Error | null) => {
                  if (done) return;
                  if (readErr) return onError(readErr);
                  inFlight--;
                  completed++;
                  if (completed === totalChunks) {
                    done = true;
                    sftp.close(handle, () => resolve(output));
                  } else {
                    scheduleReads();
                  }
                },
              );
            }
          }

          scheduleReads();
        });
      });
    });
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
