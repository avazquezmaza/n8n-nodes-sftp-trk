import path from 'path';
import {
  IBinaryData,
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from 'n8n-workflow';
import { v4 as uuidv4 } from 'uuid';

import {
  DownloadedFile,
  ErrorCode,
  ExecutionSummary,
  FilterPattern,
  NodeStatus,
  RemoteFileInfo,
  SftpCredential,
  SftpDownloadOutput,
  StructuredError,
  StructuredWarning,
} from '../../types/common.types';
import {
  FilterEngine,
  createExtensionFilter,
  createMultiPatternFilter,
  createPatternFilter,
  passSizeFilter,
} from '../../utils/filter-engine';
import { transformError } from '../../utils/error-handler';
import { getLogger, logError, logEvent, logWarning } from '../../utils/logger';
import { SftpClient } from '../../utils/sftp-client';
import { LogEvent } from '../../types/common.types';

interface NodeRuntimeOptions {
  listOnly: boolean;
  recursive: boolean;
  maxFileSizeMB: number;
  maxFilesCount: number;
  fileTimeoutSeconds: number;
  skipErrors: boolean;
  preservePathStructure: boolean;
}

function parseOptions(ctx: IExecuteFunctions, itemIndex: number): NodeRuntimeOptions {
  const rawOptions = ctx.getNodeParameter('options', itemIndex, {}) as IDataObject;

  return {
    listOnly: Boolean(rawOptions.listOnly ?? false),
    recursive: Boolean(rawOptions.recursive ?? false),
    maxFileSizeMB: Number(rawOptions.maxFileSizeMB ?? 0),
    maxFilesCount: Number(rawOptions.maxFilesCount ?? 0),
    fileTimeoutSeconds: Number(rawOptions.fileTimeoutSeconds ?? 120),
    skipErrors: Boolean(rawOptions.skipErrors ?? true),
    preservePathStructure: Boolean(rawOptions.preservePathStructure ?? false),
  };
}

function toStringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function toOptionalString(value: unknown): string | undefined {
  const str = value === undefined || value === null ? '' : String(value).trim();
  return str ? str : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toSftpCredential(data: IDataObject): SftpCredential {
  const host = toStringValue(data.host ?? data.hostname);
  const username = toOptionalString(data.username ?? data.user);
  const password = toOptionalString(data.password);
  const privateKey = toOptionalString(data.privateKey ?? data.privatekey);
  const passphrase = toOptionalString(data.passphrase);
  const port = toOptionalNumber(data.port);

  return {
    host,
    port,
    username,
    password,
    privateKey,
    passphrase,
    authMethod: privateKey ? 'key' : 'password',
  };
}

function buildFilterEngine(
  ctx: IExecuteFunctions,
  downloadMode: 'all' | 'filtered',
  itemIndex: number
): FilterEngine {
  if (downloadMode === 'all') {
    return new FilterEngine();
  }

  const filterType = ctx.getNodeParameter('filterType', itemIndex) as
    | 'extension'
    | 'pattern'
    | 'multiPattern';

  if (filterType === 'extension') {
    const extension = ctx.getNodeParameter('fileExtension', itemIndex) as string;
    return createExtensionFilter(extension);
  }

  if (filterType === 'pattern') {
    const patternType = ctx.getNodeParameter('patternType', itemIndex) as 'glob' | 'regex';
    const includePattern = ctx.getNodeParameter('includePattern', itemIndex, '') as string;
    const excludePattern = ctx.getNodeParameter('excludePattern', itemIndex, '') as string;
    return createPatternFilter(patternType, includePattern || undefined, excludePattern || undefined);
  }

  const raw = ctx.getNodeParameter('multiplePatterns', itemIndex, []) as string | FilterPattern[];
  const parsed = Array.isArray(raw) ? raw : (JSON.parse(raw) as FilterPattern[]);
  return createMultiPatternFilter(parsed);
}

function toHumanSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function toDownloadedFile(
  file: RemoteFileInfo,
  remoteDirectory: string,
  downloadTimeMs: number,
  metadata?: Record<string, unknown>
): DownloadedFile {
  return {
    id: uuidv4(),
    fileName: file.filename,
    filePath: path.posix.join(remoteDirectory, file.filename),
    size: file.size,
    sizeHuman: toHumanSize(file.size),
    extension: path.extname(file.filename),
    modifiedAt: new Date(file.modifyTime).toISOString(),
    downloadStatus: 'success',
    downloadedAt: new Date().toISOString(),
    downloadTimeMs,
    metadata,
  };
}

function toDownloadedFileListOnly(file: RemoteFileInfo, remoteDirectory: string): DownloadedFile {
  return {
    id: uuidv4(),
    fileName: file.filename,
    filePath: path.posix.join(remoteDirectory, file.filename),
    size: file.size,
    sizeHuman: toHumanSize(file.size),
    extension: path.extname(file.filename),
    modifiedAt: new Date(file.modifyTime).toISOString(),
    downloadStatus: 'skipped',
    skipReason: 'listOnly mode enabled',
    downloadTimeMs: 0,
  };
}

function buildSummary(
  listedFiles: RemoteFileInfo[],
  processedFiles: DownloadedFile[],
  listOnly: boolean
): ExecutionSummary {
  const totalByteDownloaded = listOnly
    ? 0
    : processedFiles.reduce((acc, file) => acc + file.size, 0);

  const totalDownloadTimeMs = listOnly
    ? 0
    : processedFiles.reduce((acc, file) => acc + file.downloadTimeMs, 0);

  const averageBytesPerSecond =
    totalDownloadTimeMs > 0
      ? Math.round(totalByteDownloaded / (totalDownloadTimeMs / 1000))
      : 0;

  return {
    totalFilesFound: listedFiles.length,
    totalFilesProcessed: processedFiles.length,
    totalFilesSkipped: Math.max(0, listedFiles.length - processedFiles.length),
    totalByteDownloaded,
    totalDownloadTimeMs,
    averageBytesPerSecond,
  };
}

function resolveStatus(processedFilesCount: number, errorsCount: number): NodeStatus {
  if (errorsCount > 0 && processedFilesCount > 0) return 'partial_success';
  if (errorsCount > 0 && processedFilesCount === 0) return 'error';
  if (processedFilesCount === 0) return 'empty';
  return 'success';
}

export class SftpDownload implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'SFTP Download TRK',
    name: 'sftpDownloadTrk',
    group: ['transform'],
    version: 1,
    description: 'Securely download files from SFTP with advanced filters',
    icon: 'fa:folder-open',
    defaults: {
      name: 'SFTP Download TRK',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'sftpTrk',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'download',
        options: [
          { name: 'List Folder Content', value: 'list' },
          { name: 'Download a File Set', value: 'download' },
          { name: 'Upload a File', value: 'upload' },
          { name: 'Delete a File or Folder', value: 'delete' },
          { name: 'Rename / Move a File or Folder', value: 'move' },
        ],
      },
      {
        displayName: 'Remote Directory',
        name: 'remoteDirectory',
        type: 'string',
        default: '/exports',
        required: true,
        description: 'Absolute remote directory path on the SFTP server',
        displayOptions: {
          show: {
            operation: ['list', 'download'],
          },
        },
      },
      {
        displayName: 'Download Mode',
        name: 'downloadMode',
        type: 'options',
        default: 'all',
        displayOptions: {
          show: {
            operation: ['download'],
          },
        },
        options: [
          { name: 'All Files', value: 'all' },
          { name: 'Filtered', value: 'filtered' },
        ],
      },
      {
        displayName: 'Filter Type',
        name: 'filterType',
        type: 'options',
        default: 'extension',
        displayOptions: {
          show: {
            operation: ['download'],
            downloadMode: ['filtered'],
          },
        },
        options: [
          { name: 'Extension', value: 'extension' },
          { name: 'Pattern', value: 'pattern' },
          { name: 'Multi Pattern (JSON)', value: 'multiPattern' },
        ],
      },
      {
        displayName: 'File Extension',
        name: 'fileExtension',
        type: 'string',
        default: '.csv',
        displayOptions: {
          show: {
            operation: ['download'],
            downloadMode: ['filtered'],
            filterType: ['extension'],
          },
        },
      },
      {
        displayName: 'Pattern Type',
        name: 'patternType',
        type: 'options',
        default: 'glob',
        displayOptions: {
          show: {
            operation: ['download'],
            downloadMode: ['filtered'],
            filterType: ['pattern'],
          },
        },
        options: [
          { name: 'Glob', value: 'glob' },
          { name: 'Regex', value: 'regex' },
        ],
      },
      {
        displayName: 'Include Pattern',
        name: 'includePattern',
        type: 'string',
        default: '*.csv',
        displayOptions: {
          show: {
            operation: ['download'],
            downloadMode: ['filtered'],
            filterType: ['pattern'],
          },
        },
      },
      {
        displayName: 'Exclude Pattern',
        name: 'excludePattern',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            operation: ['download'],
            downloadMode: ['filtered'],
            filterType: ['pattern'],
          },
        },
      },
      {
        displayName: 'Multi Pattern Rules (JSON)',
        name: 'multiplePatterns',
        type: 'json',
        default: '[]',
        description:
          'Array of rules: [{"type":"include|exclude","patternType":"glob|regex","pattern":"*.csv"}]',
        displayOptions: {
          show: {
            operation: ['download'],
            downloadMode: ['filtered'],
            filterType: ['multiPattern'],
          },
        },
      },
      {
        displayName: 'Remote File Path',
        name: 'remoteFilePath',
        type: 'string',
        default: '/exports/file.txt',
        required: true,
        description: 'Absolute remote file path',
        displayOptions: {
          show: {
            operation: ['upload'],
          },
        },
      },
      {
        displayName: 'Binary Property',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Binary property from input item to upload',
        displayOptions: {
          show: {
            operation: ['upload'],
          },
        },
      },
      {
        displayName: 'Delete Path',
        name: 'deletePath',
        type: 'string',
        default: '/exports/file.txt',
        required: true,
        description: 'Absolute remote path to delete',
        displayOptions: {
          show: {
            operation: ['delete'],
          },
        },
      },
      {
        displayName: 'Delete Type',
        name: 'deleteType',
        type: 'options',
        default: 'file',
        options: [
          { name: 'File', value: 'file' },
          { name: 'Directory', value: 'directory' },
        ],
        displayOptions: {
          show: {
            operation: ['delete'],
          },
        },
      },
      {
        displayName: 'Source Path',
        name: 'sourcePath',
        type: 'string',
        default: '/exports/source.txt',
        required: true,
        description: 'Current remote path',
        displayOptions: {
          show: {
            operation: ['move'],
          },
        },
      },
      {
        displayName: 'Destination Path',
        name: 'destinationPath',
        type: 'string',
        default: '/exports/destination.txt',
        required: true,
        description: 'New remote path',
        displayOptions: {
          show: {
            operation: ['move'],
          },
        },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: {
          show: {
            operation: ['list', 'download'],
          },
        },
        options: [
          {
            displayName: 'List Only',
            name: 'listOnly',
            type: 'boolean',
            default: false,
            description: 'If enabled, only list files and do not download content',
          },
          {
            displayName: 'Recursive',
            name: 'recursive',
            type: 'boolean',
            default: false,
            description: 'Recursively scan subdirectories',
          },
          {
            displayName: 'Max File Size (MB)',
            name: 'maxFileSizeMB',
            type: 'number',
            default: 0,
            description: '0 means unlimited',
          },
          {
            displayName: 'Max Files Count',
            name: 'maxFilesCount',
            type: 'number',
            default: 0,
            description: '0 means unlimited',
          },
          {
            displayName: 'File Timeout (Seconds)',
            name: 'fileTimeoutSeconds',
            type: 'number',
            default: 120,
          },
          {
            displayName: 'Skip Errors',
            name: 'skipErrors',
            type: 'boolean',
            default: true,
          },
          {
            displayName: 'Preserve Path Structure',
            name: 'preservePathStructure',
            type: 'boolean',
            default: false,
            description: 'Reserved for future local storage modes',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const logger = getLogger('sftp-download-node');
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      let client: SftpClient | null = null;

      try {
        logEvent(logger, {
          event: LogEvent.EXECUTION_STARTED,
          operationName: 'sftp_download_execute',
        });
        const operation = this.getNodeParameter('operation', itemIndex) as
          | 'list'
          | 'download'
          | 'upload'
          | 'delete'
          | 'move';
        const options = parseOptions(this, itemIndex);

        const credentialsData = await this.getCredentials('sftpTrk');
        const credential = toSftpCredential(credentialsData as IDataObject);

        client = new SftpClient(credential, {
          fileTimeoutMs: Math.max(1, options.fileTimeoutSeconds) * 1000,
        });

        await client.connect();

        if (operation === 'upload') {
          const remoteFilePath = this.getNodeParameter('remoteFilePath', itemIndex) as string;
          const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
          const content = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
          const uploadResult = await client.uploadFile(remoteFilePath, content);

          results.push({
            json: {
              status: 'success',
              operation,
              timestamp: new Date().toISOString(),
              remoteFilePath,
              sizeBytes: uploadResult.sizeBytes,
              durationMs: uploadResult.durationMs,
            },
          });
          continue;
        }

        if (operation === 'delete') {
          const deletePath = this.getNodeParameter('deletePath', itemIndex) as string;
          const deleteType = this.getNodeParameter('deleteType', itemIndex) as 'file' | 'directory';

          await client.deletePath(deletePath, deleteType === 'directory');

          results.push({
            json: {
              status: 'success',
              operation,
              timestamp: new Date().toISOString(),
              deletePath,
              deleteType,
            },
          });
          continue;
        }

        if (operation === 'move') {
          const sourcePath = this.getNodeParameter('sourcePath', itemIndex) as string;
          const destinationPath = this.getNodeParameter('destinationPath', itemIndex) as string;

          await client.movePath(sourcePath, destinationPath);

          results.push({
            json: {
              status: 'success',
              operation,
              timestamp: new Date().toISOString(),
              sourcePath,
              destinationPath,
            },
          });
          continue;
        }

        const remoteDirectory = this.getNodeParameter('remoteDirectory', itemIndex) as string;
        const listedFiles = await client.listFiles(remoteDirectory, {
          recursive: options.recursive,
        });

        if (operation === 'list') {
          const filesAfterSize = listedFiles.filter((file) => passSizeFilter(file.size, options.maxFileSizeMB));
          const selectedFiles =
            options.maxFilesCount > 0 ? filesAfterSize.slice(0, options.maxFilesCount) : filesAfterSize;

          const listedAsOutput = selectedFiles.map((file) => toDownloadedFileListOnly(file, remoteDirectory));
          const output: SftpDownloadOutput = {
            status: selectedFiles.length === 0 ? 'empty' : 'success',
            timestamp: new Date().toISOString(),
            directory: remoteDirectory,
            summary: buildSummary(listedFiles, listedAsOutput, true),
            files: listedAsOutput,
            errors: [],
            warnings: [],
          };

          results.push({ json: output as unknown as IDataObject });
          continue;
        }

        const downloadMode = this.getNodeParameter('downloadMode', itemIndex) as 'all' | 'filtered';
        const filterEngine = buildFilterEngine(this, downloadMode, itemIndex);
        const eligibleByPattern = filterEngine.filter(listedFiles);

        const filteredBySize = eligibleByPattern.filter((file: RemoteFileInfo) =>
          passSizeFilter(file.size, options.maxFileSizeMB)
        );

        const selectedFiles =
          options.maxFilesCount > 0
            ? filteredBySize.slice(0, options.maxFilesCount)
            : filteredBySize;

        const warnings: StructuredWarning[] = [];
        const errors: StructuredError[] = [];
        const downloadedFiles: DownloadedFile[] = [];
        const binaryPayload: Record<string, IBinaryData> = {};

        if (options.listOnly) {
          for (const file of selectedFiles) {
            downloadedFiles.push(toDownloadedFileListOnly(file, remoteDirectory));
          }
        } else {
          for (const file of selectedFiles) {
            try {
              const fullRemotePath = path.posix.join(remoteDirectory, file.filename);
              const download = await client.downloadFile(fullRemotePath);
              const binaryPropertyName = `file_${downloadedFiles.length}`;
              binaryPayload[binaryPropertyName] = await this.helpers.prepareBinaryData(
                download.content,
                file.filename,
              );

              downloadedFiles.push(
                toDownloadedFile(file, remoteDirectory, download.durationMs, {
                  binaryPropertyName,
                })
              );
            } catch (error: unknown) {
              const structured = transformError(error instanceof Error ? error : String(error), {
                affectedFile: file.filename,
                affectedFilePath: path.posix.join(remoteDirectory, file.filename),
                attemptedOperation: 'downloadFile',
              });

              errors.push(structured);
              logError(logger, structured.errorCode, structured.message, {
                fileName: file.filename,
              });

              if (!options.skipErrors) {
                throw new Error(`${structured.errorCode}: ${structured.message}`);
              }
            }
          }
        }

        const skippedBySize = eligibleByPattern.length - filteredBySize.length;
        if (skippedBySize > 0) {
          warnings.push({
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            severity: 'warning',
            errorCode: ErrorCode.FILE_TOO_LARGE,
            message: `${skippedBySize} file(s) were skipped by size limit`,
            suggestion: 'Increase maxFileSizeMB or change filtering criteria',
          });
          logWarning(logger, 'Files skipped by size limit', { skippedBySize });
        }

        const summary = buildSummary(listedFiles, downloadedFiles, options.listOnly);
        const status = resolveStatus(downloadedFiles.length, errors.length);

        const output: SftpDownloadOutput = {
          status,
          timestamp: new Date().toISOString(),
          directory: remoteDirectory,
          summary,
          files: downloadedFiles,
          errors,
          warnings,
        };

        logEvent(logger, {
          event: errors.length ? LogEvent.EXECUTION_FAILED : LogEvent.EXECUTION_COMPLETED,
          remoteDirectory,
          totalFilesFound: listedFiles.length,
          totalFilesProcessed: downloadedFiles.length,
        });

        results.push({
          json: output as unknown as IDataObject,
          ...(Object.keys(binaryPayload).length > 0 ? { binary: binaryPayload } : {}),
        });
      } catch (error: unknown) {
        const structured = transformError(error instanceof Error ? error : String(error), {
          attemptedOperation: 'execute',
        });

        if (this.continueOnFail()) {
          results.push({
            json: {
              status: 'error',
              message: structured.message,
              errorCode: structured.errorCode,
            },
          });
          continue;
        }

        throw error;
      } finally {
        if (client) {
          await client.disconnect();
        }
      }
    }

    return [results];
  }
}
