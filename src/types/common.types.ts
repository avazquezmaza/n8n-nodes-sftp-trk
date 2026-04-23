/**
 * Tipos de eventos que se loguean
 */
export enum LogEvent {
  // Eventos de inicio/fin
  EXECUTION_STARTED = 'execution_started',
  EXECUTION_COMPLETED = 'execution_completed',
  EXECUTION_FAILED = 'execution_failed',
  
  // Eventos de conexión
  CONNECTION_STARTED = 'connection_started',
  CONNECTION_ESTABLISHED = 'connection_established',
  CONNECTION_FAILED = 'connection_failed',
  CONNECTION_CLOSED = 'connection_closed',
  
  // Eventos de validación
  VALIDATION_STARTED = 'validation_started',
  VALIDATION_PASSED = 'validation_passed',
  VALIDATION_FAILED = 'validation_failed',
  
  // Eventos de descarga de archivos
  FILE_LISTED = 'file_listed',
  FILE_DOWNLOAD_STARTED = 'file_download_started',
  FILE_DOWNLOAD_COMPLETED = 'file_download_completed',
  FILE_DOWNLOAD_FAILED = 'file_download_failed',
  FILE_SKIPPED = 'file_skipped',
  
  // Eventos de filtrado
  FILTER_APPLIED = 'filter_applied',
  PATTERN_VALIDATED = 'pattern_validated',
  FILTER_EXCLUDED_FILE = 'filter_excluded_file',
  
  // Errores
  ERROR_OCCURRED = 'error_occurred',
  SECURITY_VALIDATION_FAILED = 'security_validation_failed',
  WARNING_OCCURRED = 'warning_occurred',
}

/**
 * Estructura de log estructurado SEGURO
 */
export interface StructuredLogData {
  event: LogEvent | string;
  timestamp?: string;
  
  // Contexto general
  workflowId?: string;
  executionId?: string;
  
  // SFTP Context (SEGURO)
  remoteDirectory?: string;
  serverHostname?: string;
  
  // Información de descarga
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  
  // Información de operación
  operationName?: string;
  durationMs?: number;
  statusCode?: string;
  
  // Información técnica (ojo: no incluir credenciales)
  errorCode?: string;
  errorMessage?: string;
  
  // Metadata adicional
  [key: string]: unknown;
}
/**
 * Tipos comunes para el nodo SFTP Download
 */

/**
 * Estados posibles de una descarga
 */
export type DownloadStatus = 'success' | 'skipped' | 'failed';

/**
 * Estados de retorno del nodo
 */
export type NodeStatus = 'success' | 'empty' | 'partial_success' | 'error';

/**
 * Severidad de errores
 */
export type ErrorSeverity = 'warning' | 'error' | 'fatal';

/**
 * Códigos de error estándar
 */
export enum ErrorCode {
  // Connection errors
  SFTP_CONNECTION_FAILED = 'SFTP_CONNECTION_FAILED',
  SFTP_CONNECTION_REFUSED = 'SFTP_CONNECTION_REFUSED',
  SFTP_CONNECTION_TIMEOUT = 'SFTP_CONNECTION_TIMEOUT',
  SFTP_AUTH_FAILED = 'SFTP_AUTH_FAILED',
  SFTP_HOST_NOT_FOUND = 'SFTP_HOST_NOT_FOUND',
  SFTP_INVALID_HOST = 'SFTP_INVALID_HOST',
  
  // Path errors
  PATH_NOT_FOUND = 'PATH_NOT_FOUND',
  PATH_TRAVERSAL_ATTEMPT = 'PATH_TRAVERSAL_ATTEMPT',
  INVALID_PATH = 'INVALID_PATH',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  
  // File errors
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  TIMEOUT = 'TIMEOUT',
  
  // System/Resource errors
  DISK_SPACE_ERROR = 'DISK_SPACE_ERROR',
  WRITE_PERMISSION_DENIED = 'WRITE_PERMISSION_DENIED',
  OUT_OF_MEMORY = 'OUT_OF_MEMORY',
  
  // Validation errors
  INVALID_PATTERN = 'INVALID_PATTERN',
  REGEX_REDOS_DETECTED = 'REGEX_REDOS_DETECTED',
  INVALID_PARAMETERS = 'INVALID_PARAMETERS',
  
  // Unknown error
  UNKNOWN = 'UNKNOWN',
}

/**
 * Información de un archivo remote
 */
export interface RemoteFileInfo {
  filename: string;
  size: number;
  modifyTime: number;
  isDirectory?: boolean;
  longname?: string;
  attrs?: { remotePath: string };
}

/**
 * Archivo descargado con metadata
 */
export interface DownloadedFile {
  id: string;
  fileName: string;
  filePath: string;
  filePathRelative?: string;
  size: number;
  sizeHuman: string;
  extension: string;
  modifiedAt: string;
  downloadStatus: DownloadStatus;
  downloadedAt?: string;
  downloadTimeMs: number;
  localPath?: string;
  skipReason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Error con información de contexto
 */
export interface StructuredError {
  id: string;
  timestamp: string;
  severity: ErrorSeverity;
  errorCode: ErrorCode | string;
  message: string;
  affectedFile?: string;
  affectedFilePath?: string;
  suggestion?: string;
  context?: Record<string, unknown>;
  description?: string;
}

/**
 * Warning/Aviso
 */
export interface StructuredWarning {
  id: string;
  timestamp: string;
  severity: 'warning';
  errorCode?: string;
  message: string;
  affectedFile?: string;
  affectedFilePath?: string;
  suggestion?: string;
}

/**
 * Resumen de ejecución
 */
export interface ExecutionSummary {
  totalFilesFound: number;
  totalFilesProcessed: number;
  totalFilesSkipped: number;
  totalByteDownloaded: number;
  totalDownloadTimeMs: number;
  averageBytesPerSecond: number;
}

/**
 * Output estructurado del nodo
 */
export interface SftpDownloadOutput {
  status: NodeStatus;
  timestamp: string;
  directory: string;
  summary: ExecutionSummary;
  files: DownloadedFile[];
  errors: StructuredError[];
  warnings: StructuredWarning[];
}

/**
 * Parámetros de entrada del nodo
 */
export interface SftpDownloadParameters {
  sftpConnection: {
    mode: string;
    value: string;
  };
  remoteDirectory: string;
  downloadMode: 'all' | 'filtered';
  filterType?: 'extension' | 'pattern' | 'multiPattern';
  fileExtension?: string;
  patternType?: 'glob' | 'regex';
  includePattern?: string;
  excludePattern?: string;
  multiplePatterns?: FilterPattern[];
  options?: {
    listOnly?: boolean;
    recursive?: boolean;
    maxFileSizeMB?: number;
    maxFilesCount?: number;
    fileTimeoutSeconds?: number;
    skipErrors?: boolean;
    preservePathStructure?: boolean;
  };
}

/**
 * Patrón de filtro individual
 */
export interface FilterPattern {
  type: 'include' | 'exclude';
  patternType: 'glob' | 'regex';
  pattern: string;
  description?: string;
}

/**
 * Credencial SFTP
 */
export interface SftpCredential {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  authMethod?: 'key' | 'password';
  allowedBasePath?: string;
}
