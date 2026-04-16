/**
 * Logger seguro y estructurado
 * 
 * CRÍTICO PARA SEGURIDAD:
 * - Redacción automática de información sensible
 * - Sin estar credenciales en logs
 * - Logging estructurado en JSON
 */

import pino, { Logger as PinoLogger } from 'pino';

/**
 * Configuración de redaction
 * Estos campos serán reemplazados por [REDACTED] automáticamente
 */
const REDACTION_PATHS = [
  'credential.password',
  'credential.privateKey',
  'credential.passphrase',
  'credential.token',
  'credential.secret',
  'credential.apiKey',
  'authData.password',
  'authData.token',
  'authData.secret',
  'connection.password',
  'connection.privateKey',
  'sftpConfig.password',
  'sftpConfig.privateKey',
  '*.password',
  '*.privateKey',
  '*.token',
  '*.secret',
  '*.apiKey',
];

/**
/**
 * Crear logger seguro y estructurado
 * 
 * @param name - Nombre del logger (ej: 'sftp-validator')
 * @param level - Nivel de log (ej: 'info', 'debug', 'error')
 * @returns Logger de pino configurado
 */
export function createSecureLogger(
  name: string,
  level: string = process.env.LOG_LEVEL || 'info'
): PinoLogger {
  const logger = pino(
    {
      name,
      level,
      
      // Redaction automática de información sensible
      redact: {
        paths: REDACTION_PATHS,
        censor: '[REDACTED]',
      },
      
      // Timestamp en ISO 8601 UTC
      timestamp: pino.stdTimeFunctions.isoTime,
      
      // Serializers estándar
      serializers: {
        err: pino.stdSerializers.err,
        req: pino.stdSerializers.req,
        res: pino.stdSerializers.res,
      },
      
      // Formato de transporte según ambiente
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
                singleLine: false,
              },
            },
    }
  );

  return logger;
}

/**
 * Logger global de aplicación
 */
let globalLogger: PinoLogger | null = null;

/**
 * Obtener o crear logger global
 */
export function getLogger(name: string = 'sftp-download'): PinoLogger {
  if (!globalLogger) {
    globalLogger = createSecureLogger(name);
  }
  return globalLogger;
}

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
  
  // Errores
  ERROR_OCCURRED = 'error_occurred',
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
  serverHostname?: string;  // ✅ PERMITIDO: nombre del host genérico
  
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
 * Loguear evento de forma segura
 * 
 * ✅ SEGURO: Automáticamente redacta credenciales
 * ❌ NUNCA loguear: password, privateKey, tokens
 * 
 * @param logger - Logger de pino
 * @param data - Datos a loguear (estructura segura)
 * @param level - Nivel de log (default: 'info')
 */
export function logEvent(
  logger: PinoLogger,
  data: StructuredLogData,
  level: 'info' | 'warn' | 'error' | 'debug' = 'info'
): void {
  // Agregar timestamp si no tiene
  if (!data.timestamp) {
    data.timestamp = new Date().toISOString();
  }

  // Loguear según nivel
  logger[level](data, `[${data.event}]`);
}

/**
 * Ejemplos de uso SEGURO
 * 
 * ✅ CORRECTO:
 * ```typescript
 * logEvent(logger, {
 *   event: LogEvent.FILE_DOWNLOAD_STARTED,
 *   fileName: 'report.csv',
 *   fileSize: 1024,
 *   remoteDirectory: '/exports/reports'
 * });
 * ```
 * 
 * ❌ INCORRECTO:
 * ```typescript
 * logEvent(logger, {
 *   event: LogEvent.CONNECTION_ESTABLISHED,
 *   password: 'secret123'    // ❌ NUNCA
 * });
 * ```
 */

/**
 * Loguear error de forma segura (SIN exponer infraestructura)
 */
export function logError(
  logger: PinoLogger,
  errorCode: string,
  message: string,
  context?: Record<string, unknown>
): void {
  logEvent(
    logger,
    {
      event: LogEvent.ERROR_OCCURRED,
      errorCode,
      errorMessage: message,
      ...(context && { context }),
    },
    'error'
  );
}

/**
 * Loguear warning
 */
export function logWarning(
  logger: PinoLogger,
  message: string,
  context?: Record<string, unknown>
): void {
  logEvent(
    logger,
    {
      event: LogEvent.WARNING_OCCURRED,
      errorMessage: message,
      ...(context && { context }),
    },
    'warn'
  );
}

/**
 * Loguear en nivel DEBUG (información técnica)
 * Se usa solo cuando LOG_LEVEL=debug
 */
export function logDebug(
  logger: PinoLogger,
  event: string,
  data: Record<string, unknown>
): void {
  logEvent(logger, { event, ...data }, 'debug');
}
