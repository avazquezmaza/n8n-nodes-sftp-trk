/**
 * Error Handler centralizado
 * 
 * Mapea errores técnicos a mensajes seguros y clasificables
 * NUNCA expone credenciales o detalles de infraestructura
 */

import { v4 as uuidv4 } from 'uuid';
import { ErrorCode, StructuredError, ErrorSeverity } from '../types/common.types';

/**
 * Mapeo de errores técnicos a mensajes seguros
 */
interface ErrorMapping {
  code: ErrorCode | string;
  userMessage: string;
  supportMessage: string;
  severity: ErrorSeverity;
  retryable: boolean;
}

/**
 * Diccionario central de mapeo de errores
 */
const ERROR_MAPPINGS: Record<string, ErrorMapping> = {
  // Connection errors - SSH/SFTP
  'All configured authentication methods failed': {
    code: ErrorCode.SFTP_AUTH_FAILED,
    userMessage: 'Unable to authenticate with SFTP server',
    supportMessage:
      'SSH authentication failed. Verify credentials in n8n credential store.',
    severity: 'error',
    retryable: true,
  },
  
  ECONNREFUSED: {
    code: ErrorCode.SFTP_CONNECTION_REFUSED,
    userMessage: 'Cannot reach SFTP server',
    supportMessage: 'Connection refused - verify server is running and accessible.',
    severity: 'error',
    retryable: true,
  },
  
  ENOTFOUND: {
    code: ErrorCode.SFTP_HOST_NOT_FOUND,
    userMessage: 'Unable to resolve SFTP server address',
    supportMessage:
      'Hostname resolution failed. Verify server configuration is correct.',
    severity: 'error',
    retryable: true,
  },
  
  'connect ETIMEDOUT': {
    code: ErrorCode.SFTP_CONNECTION_TIMEOUT,
    userMessage: 'Connection to SFTP server timed out',
    supportMessage:
      'Connection timeout - verify network connectivity and server is accessible.',
    severity: 'error',
    retryable: true,
  },
  
  'Timed out': {
    code: ErrorCode.TIMEOUT,
    userMessage: 'Operation timed out',
    supportMessage: 'Operation exceeded timeout threshold.',
    severity: 'error',
    retryable: true,
  },
  
  // Permission errors
  'Permission denied': {
    code: ErrorCode.PERMISSION_DENIED,
    userMessage: 'Permission denied accessing remote file or directory',
    supportMessage:
      'SFTP user lacks read permission. Verify permissions on remote server.',
    severity: 'error',
    retryable: false,
  },
  
  // File system errors
  ENOSPC: {
    code: ErrorCode.DISK_SPACE_ERROR,
    userMessage: 'Insufficient disk space in execution environment',
    supportMessage:
      'No space left on device. Free up disk space or reduce file size limits.',
    severity: 'error',
    retryable: false,
  },
  
  EACCES: {
    code: ErrorCode.WRITE_PERMISSION_DENIED,
    userMessage: 'Cannot write to destination directory',
    supportMessage:
      'Permission denied writing files. Check filesystem permissions.',
    severity: 'error',
    retryable: false,
  },
  
  ENOMEM: {
    code: ErrorCode.OUT_OF_MEMORY,
    userMessage: 'Out of memory',
    supportMessage: 'Insufficient memory available. Reduce batch size or file limits.',
    severity: 'error',
    retryable: false,
  },
  
  // Path errors
  ENOENT: {
    code: ErrorCode.FILE_NOT_FOUND,
    userMessage: 'File or directory not found',
    supportMessage: 'Remote path does not exist. Verify path is correct.',
    severity: 'error',
    retryable: false,
  },

  // ssh2-sftp-client generic SFTP failure (SSH_FX_FAILURE, status code 4)
  // Triggered when the server rejects the operation: path does not exist as a
  // directory, wrong type (file vs dir), or access is denied at the protocol level.
  'An unexpected error occurred': {
    code: ErrorCode.SFTP_OPERATION_FAILED,
    userMessage: 'SFTP operation failed — path may not exist, may not be a directory, or access is restricted',
    supportMessage: 'SSH_FX_FAILURE (code 4) from server. Check that the remote path exists and is accessible.',
    severity: 'error',
    retryable: false,
  },

  'No such file': {
    code: ErrorCode.FILE_NOT_FOUND,
    userMessage: 'Remote path not found',
    supportMessage: 'Server returned "No such file or directory". Verify the path exists on the SFTP server.',
    severity: 'error',
    retryable: false,
  },

  // ssh2-sftp-client list failures often surface as:
  // `list: /path /path` or `list: /path <server message>`
  'list:': {
    code: ErrorCode.SFTP_OPERATION_FAILED,
    userMessage: 'Unable to list remote directory — path may not exist, may not be a directory, or access is restricted',
    supportMessage:
      'SFTP list operation failed. Verify the target path exists, is a directory, and the user has read permissions.',
    severity: 'error',
    retryable: false,
  },
};

/**
 * Transformar error técnico en StructuredError seguro
 * 
 * @param rawError - Error original (Error object o string)
 * @param context - Contexto adicional (archivo, operación, etc)
 * @returns StructuredError con información segura
 */
export function transformError(
  rawError: Error | string,
  context?: {
    affectedFile?: string;
    affectedFilePath?: string;
    attemptedOperation?: string;
  }
): StructuredError {
  const errorMessage = typeof rawError === 'string' ? rawError : rawError.message || String(rawError);

  // Buscar en mapping
  let mapping: ErrorMapping | null = null;
  for (const [key, value] of Object.entries(ERROR_MAPPINGS)) {
    if (errorMessage.includes(key)) {
      mapping = value;
      break;
    }
  }

  // Si no encontramos mapping, usar genérico
  if (!mapping) {
    mapping = {
      code: ErrorCode.UNKNOWN,
      userMessage: 'An unexpected error occurred',
      supportMessage: `Unknown error type. Technical details: ${errorMessage}`,
      severity: 'error',
      retryable: false,
    };
  }

  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    severity: mapping.severity,
    errorCode: mapping.code,
    message: mapping.userMessage,
    affectedFile: context?.affectedFile,
    affectedFilePath: context?.affectedFilePath,
    suggestion: getSuggestionForError(mapping.code),
    context: {
      attemptedOperation: context?.attemptedOperation,
      retryable: mapping.retryable,
      supportMessage: mapping.supportMessage,
      rawError: errorMessage,
    },
  };
}

/**
 * Obtener sugerencia de resolución según código de error
 * 
 * @param errorCode - Código de error
 * @returns Sugerencia de resolución segura
 */
export function getSuggestionForError(errorCode: ErrorCode | string): string {
  const suggestions: Record<string, string> = {
    [ErrorCode.SFTP_AUTH_FAILED]:
      'Verify SFTP credentials are correct in n8n credential store',
    [ErrorCode.SFTP_CONNECTION_REFUSED]:
      'Ensure SFTP server is running and accessible from n8n',
    [ErrorCode.SFTP_HOST_NOT_FOUND]:
      'Verify server hostname is correct and accessible',
    [ErrorCode.SFTP_CONNECTION_TIMEOUT]:
      'Check network connectivity and server is responding',
    [ErrorCode.PATH_NOT_FOUND]:
      'Verify remote directory path exists on SFTP server',
    [ErrorCode.PERMISSION_DENIED]:
      'Contact system administrator to grant read/write permissions',
    [ErrorCode.DISK_SPACE_ERROR]:
      'Free up disk space on n8n execution environment or reduce file limits',
    [ErrorCode.FILE_TOO_LARGE]:
      'Increase maxFileSizeMB parameter or exclude large files using filters',
    [ErrorCode.TIMEOUT]:
      'Increase timeout threshold or check server performance',
    [ErrorCode.INVALID_PATTERN]:
      'Fix pattern syntax - use glob (*,?) or valid regex',
    [ErrorCode.REGEX_REDOS_DETECTED]:
      'Simplify regex pattern or use glob patterns instead',
    [ErrorCode.PATH_TRAVERSAL_ATTEMPT]:
      'Use absolute paths only, do not include .. or relative references',
  };

  return (
    suggestions[errorCode] ||
    'Check logs for more details or contact support'
  );
}

/**
 * Validar que un error NO contiene información sensible
 * (Útil para debugging en desarrollo)
 * 
 * @param error - Error a validar
 * @returns true si es seguro, false si contiene datos sensibles
 */
export function isErrorSafe(error: StructuredError | string): boolean {
  const errorStr = typeof error === 'string' ? error : JSON.stringify(error);

  const sensitivePatterns = [
    /password/i,
    /private.*key/i,
    /secret/i,
    /token/i,
    /credential/i,
    /api.*key/i,
    /auth/i,
  ];

  return !sensitivePatterns.some((pattern) => pattern.test(errorStr));
}

/**
 * Crear error estructurado desde validación
 * 
 * @param message - Mensaje de error
 * @param code - Código de error
 * @param severity - Severidad
 * @param context - Contexto adicional
 * @returns StructuredError
 */
export function createStructuredError(
  message: string,
  code: ErrorCode | string = ErrorCode.UNKNOWN,
  severity: ErrorSeverity = 'error',
  context?: Record<string, unknown>
): StructuredError {
  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    severity,
    errorCode: code,
    message,
    suggestion: getSuggestionForError(code),
    context,
  };
}

/**
 * Sanitizar mensaje de error (remover datos sensibles)
 * 
 * @param message - Mensaje original
 * @returns Mensaje sanitizado
 */
export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;

  // Patrones a reemplazar
  const patterns = [
    { regex: /password[=:]\s*[^\s,}]+/gi, replacement: 'password=[REDACTED]' },
    { regex: /user\s*=\s*[^\s,}]+/gi, replacement: 'user=[REDACTED]' },
    { regex: /(ssh|private)\s*key[=:]\s*[^\s,}]+/gi, replacement: 'key=[REDACTED]' },
    { regex: /token[=:]\s*[^\s,}]+/gi, replacement: 'token=[REDACTED]' },
    { regex: /\/home\/\w+/g, replacement: '/home/[USER]' },
    { regex: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, replacement: '[IP]' },
  ];

  for (const { regex, replacement } of patterns) {
    sanitized = sanitized.replace(regex, replacement);
  }

  return sanitized;
}
