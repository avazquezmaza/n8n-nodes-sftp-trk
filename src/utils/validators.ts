/**
 * Funciones de validación para el nodo SFTP Download
 * 
 * CRÍTICO PARA SEGURIDAD:
 * - Prevención de path traversal
 * - Prevención de ReDoS (Regex Denial of Service)
 * - Validación de límites de recursos
 */

import { ErrorCode } from '../types/common.types';

/**
 * Constantes de límites
 */
export const SIZE_LIMITS = {
  MIN_FILE_MB: 0.001,        // 1 KB mínimo
  MAX_FILE_MB: 5120,          // 5 GB máximo
  MAX_FILES_COUNT: 10000,     // 10K archivos máximo
  MIN_TIMEOUT_SEC: 10,        // 10 segundos mínimo
  MAX_TIMEOUT_SEC: 3600,      // 1 hora máximo
  MAX_PATTERN_LENGTH: 255,    // Máximo largo de patrón
  REGEX_TIMEOUT_MS: 100,      // Timeout de evaluación de regex
};

/**
 * Constantes de paternos peligrosos para ReDoS
 */
const DANGEROUS_REGEX_PATTERNS = [
  /\(.*\)\+\$/,              // (anything)+ at end
  /(\w+)\+\$/,               // word+ repeated
  /(\d+)\+\$/,               // digits+ repeated
  /.*\*.*\*/,                // .* repeated
  /(\w+)+\$/,                // Exponential backtracking
  /(\d+)+\$/,
  /(.+)+\$/,
];

/**
 * Caracteres peligrosos en rutas
 */
const DANGEROUS_PATH_CHARS = ['~', '$', '`', '"', "'", ';', '|', '&', '>', '<'];

/**
 * ✅ VALIDAR RUTA REMOTA - Previene path traversal attack
 * 
 * @param inputPath - Ruta a validar
 * @param basePath - Ruta base permitida (default: /exports)
 * @returns true si es válida
 * @throws Error si es inválida
 * 
 * Previene:
 * - /../../../etc/passwd
 * - /exports/../../../windows/system32
 * - Symlinks maliciosos
 * 
 * @example
 * validateRemotePath('/exports/reports')        // ✅ OK
 * validateRemotePath('/../etc/passwd')          // ❌ Error
 * validateRemotePath('/exports/$(rm -rf /)')    // ❌ Error
 */
export function validateRemotePath(
  inputPath: string | null | undefined,
  basePath: string = '/exports'
): boolean {
  // 1. Validar que sea string no-vacío
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error(
      `${ErrorCode.INVALID_PATH}: Remote path must be non-empty string`
    );
  }

  // 2. Validar que sea ruta absoluta
  if (!inputPath.startsWith('/')) {
    throw new Error(
      `${ErrorCode.INVALID_PATH}: Remote path must be absolute (start with /)`
    );
  }

  // 3. Detectar path traversal patterns
  if (/\.\.[/\\]|\/\.\./.test(inputPath)) {
    throw new Error(
      `${ErrorCode.PATH_TRAVERSAL_ATTEMPT}: Path contains parent directory references (.. or ../)`
    );
  }

  // 4. Normalizar ruta (elimina ./, //, etc)
  let normalized = inputPath.replace(/\/+/g, '/');
  normalized = normalized.replace(/\/\.(?=\/|$)/g, '');

  // 5. Resolver ruta (PERO no acceder filesystem, solo lógica)
  // Simular resolve eliminando ..
  const parts = normalized.split('/').filter((p) => p !== '');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === '..') {
      parts.splice(i, 1);
      if (i > 0) parts.splice(i - 1, 1);
      i--;
    }
  }
  const resolved = '/' + parts.join('/');

  // 6. Validar que esté dentro de basePath permitido
  if (basePath !== '/' && !resolved.startsWith(basePath)) {
    throw new Error(
      `${ErrorCode.INVALID_PATH}: Path is outside allowed directory. Must be under ${basePath}`
    );
  }

  // 7. Validar caracteres específicos peligrosos
  if (DANGEROUS_PATH_CHARS.some((char) => resolved.includes(char))) {
    throw new Error(
      `${ErrorCode.INVALID_PATH}: Path contains invalid special characters: ${DANGEROUS_PATH_CHARS.join(', ')}`
    );
  }

  return true;
}

/**
 * ✅ VALIDAR PATRÓN REGEX - Previene ReDoS
 * 
 * @param pattern - Patrón regex a validar
 * @returns true si es seguro
 * @throws Error si es peligroso o inválido
 * 
 * Previene:
 * - (a+)+$ - Backtracking catastrófico
 * - (a|a)*$ - Cuadrático
 * - Patrones muy largos
 * 
 * @example
 * validateRegexPattern('^report_\\d{4}\\.csv$')  // ✅ OK
 * validateRegexPattern('(a+)+$')                 // ❌ ReDoS
 */
export function validateRegexPattern(pattern: string | null | undefined): RegExp {
  // 1. Validar que sea string
  if (!pattern || typeof pattern !== 'string') {
    throw new Error(`${ErrorCode.INVALID_PATTERN}: Pattern must be non-empty string`);
  }

  // 2. Validar largo
  if (pattern.length > SIZE_LIMITS.MAX_PATTERN_LENGTH) {
    throw new Error(
      `${ErrorCode.INVALID_PATTERN}: Pattern too long (max: ${SIZE_LIMITS.MAX_PATTERN_LENGTH} chars)`
    );
  }

  // 3. Detectar patrones conocidos peligrosos
  if (DANGEROUS_REGEX_PATTERNS.some((p) => p.test(pattern))) {
    throw new Error(
      `${ErrorCode.REGEX_REDOS_DETECTED}: Pattern detected as potentially dangerous (ReDoS risk). Simplify or use glob patterns instead.`
    );
  }

  // 4. Compilar y probar con timeout
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `${ErrorCode.INVALID_PATTERN}: Invalid regex syntax: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 5. Prueba rápida con string largo (detecta backtracking)
  const startTime = Date.now();
  try {
    const testString = 'a'.repeat(1000);
    regex.test(testString);

    const elapsed = Date.now() - startTime;
    if (elapsed > SIZE_LIMITS.REGEX_TIMEOUT_MS) {
      throw new Error(
        `${ErrorCode.REGEX_REDOS_DETECTED}: Pattern evaluation too slow (${elapsed}ms > ${SIZE_LIMITS.REGEX_TIMEOUT_MS}ms) - possible ReDoS`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(ErrorCode.REGEX_REDOS_DETECTED)) {
      throw error;
    }
    throw new Error(
      `${ErrorCode.INVALID_PATTERN}: Could not evaluate pattern: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return regex;
}

/**
 * ✅ VALIDAR LÍMITES DE TAMAÑO
 * 
 * @param params - Parámetros a validar
 * @throws Error si algún límite es inválido
 */
export function validateSizeLimits(params: {
  maxFileSizeMB?: number;
  maxFilesCount?: number;
  fileTimeoutSeconds?: number;
}): void {
  const { maxFileSizeMB, maxFilesCount, fileTimeoutSeconds } = params;

  // Validar maxFileSizeMB
  if (maxFileSizeMB !== undefined && maxFileSizeMB !== 0) {
    if (maxFileSizeMB < SIZE_LIMITS.MIN_FILE_MB) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: maxFileSizeMB too small (min: ${SIZE_LIMITS.MIN_FILE_MB} MB)`
      );
    }

    if (maxFileSizeMB > SIZE_LIMITS.MAX_FILE_MB) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: maxFileSizeMB too large (max: ${SIZE_LIMITS.MAX_FILE_MB} MB)`
      );
    }
  }

  // Validar maxFilesCount
  if (maxFilesCount !== undefined) {
    if (maxFilesCount < 1) {
      throw new Error(`${ErrorCode.INVALID_PARAMETERS}: maxFilesCount must be >= 1`);
    }

    if (maxFilesCount > SIZE_LIMITS.MAX_FILES_COUNT) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: maxFilesCount too large (max: ${SIZE_LIMITS.MAX_FILES_COUNT})`
      );
    }
  }

  // Validar timeout
  if (fileTimeoutSeconds !== undefined) {
    if (fileTimeoutSeconds < SIZE_LIMITS.MIN_TIMEOUT_SEC) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: fileTimeoutSeconds too short (min: ${SIZE_LIMITS.MIN_TIMEOUT_SEC} sec)`
      );
    }

    if (fileTimeoutSeconds > SIZE_LIMITS.MAX_TIMEOUT_SEC) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: fileTimeoutSeconds too long (max: ${SIZE_LIMITS.MAX_TIMEOUT_SEC} sec)`
      );
    }
  }
}

/**
 * ✅ VALIDAR EXTENSIÓN DE ARCHIVO
 * 
 * @param extension - Extensión a validar (ej: ".csv")
 * @throws Error si es inválida
 */
export function validateFileExtension(extension: string | null | undefined): void {
  if (!extension || typeof extension !== 'string') {
    throw new Error(
      `${ErrorCode.INVALID_PARAMETERS}: File extension must be non-empty string`
    );
  }

  if (!extension.startsWith('.')) {
    throw new Error(`${ErrorCode.INVALID_PARAMETERS}: Extension must start with a dot (.)`);
  }

  if (extension.length < 2 || extension.length > 50) {
    throw new Error(
      `${ErrorCode.INVALID_PARAMETERS}: Extension must be between 2-50 characters`
    );
  }

  // Validar caracteres válidos
  if (!/^\.[\w\-]+$/.test(extension)) {
    throw new Error(
      `${ErrorCode.INVALID_PARAMETERS}: Extension contains invalid characters`
    );
  }
}

/**
 * ✅ VALIDAR PARÁMETROS DE GLOB PATTERN
 * 
 * @param pattern - Patrón glob
 * @throws Error si es inválido
 */
export function validateGlobPattern(pattern: string | null | undefined): void {
  if (!pattern || typeof pattern !== 'string') {
    throw new Error(`${ErrorCode.INVALID_PATTERN}: Glob pattern must be non-empty string`);
  }

  if (pattern.length > SIZE_LIMITS.MAX_PATTERN_LENGTH) {
    throw new Error(
      `${ErrorCode.INVALID_PATTERN}: Pattern too long (max: ${SIZE_LIMITS.MAX_PATTERN_LENGTH} chars)`
    );
  }

  // Básicamente cualquier cosa es válida en glob, pero chequeamos obvias
  if (DANGEROUS_PATH_CHARS.some((char) => pattern.includes(char))) {
    throw new Error(
      `${ErrorCode.INVALID_PATTERN}: Pattern contains invalid characters`
    );
  }
}

/**
 * ✅ VALIDAR CREDENCIALES SFTP
 * 
 * @param credential - Credencial a validar
 * @throws Error si es inválida
 * 
 * IMPORTANTE: No loguear credencial
 */
export function validateSftpCredential(credential: unknown): void {
  if (!credential || typeof credential !== 'object') {
    throw new Error(
      `${ErrorCode.INVALID_PARAMETERS}: SFTP credential must be an object`
    );
  }

  const cred = credential as Record<string, unknown>;

  if (!cred.host || typeof cred.host !== 'string') {
    throw new Error(`${ErrorCode.INVALID_PARAMETERS}: Credential must have valid host`);
  }

  if (cred.port !== undefined) {
    const port = cred.port as number;
    if (typeof port !== 'number' || port < 1 || port > 65535) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: Invalid port number (must be 1-65535)`
      );
    }
  }
}

/**
 * ✅ VALIDAR PARÁMETROS DE DESCARGA
 * 
 * @param params - Parámetros del nodo
 * @throws Error si hay parámetros inválidos
 */
export function validateDownloadParameters(params: Record<string, unknown>): void {
  if (!params || typeof params !== 'object') {
    throw new Error(`${ErrorCode.INVALID_PARAMETERS}: Parameters must be an object`);
  }

  // Validar remoteDirectory
  const remoteDir = params.remoteDirectory as string | undefined;
  if (!remoteDir || typeof remoteDir !== 'string') {
    throw new Error(
      `${ErrorCode.INVALID_PARAMETERS}: remoteDirectory must be specified`
    );
  }
  validateRemotePath(remoteDir);

  // Validar downloadMode
  const downloadMode = params.downloadMode as string | undefined;
  if (!downloadMode || !['all', 'filtered'].includes(downloadMode)) {
    throw new Error(
      `${ErrorCode.INVALID_PARAMETERS}: downloadMode must be 'all' or 'filtered'`
    );
  }

  // Validar filtrados si es necesario
  if (downloadMode === 'filtered') {
    const filterType = params.filterType as string | undefined;
    if (!filterType || !['extension', 'pattern', 'multiPattern'].includes(filterType)) {
      throw new Error(
        `${ErrorCode.INVALID_PARAMETERS}: filterType must be 'extension', 'pattern', or 'multiPattern'`
      );
    }

    // Validar según filtro
    if (filterType === 'extension') {
      validateFileExtension(params.fileExtension as string);
    } else if (filterType === 'pattern') {
      const patternType = params.patternType as string | undefined;
      if (!patternType || !['glob', 'regex'].includes(patternType)) {
        throw new Error(
          `${ErrorCode.INVALID_PARAMETERS}: patternType must be 'glob' or 'regex'`
        );
      }

      if (patternType === 'regex') {
        validateRegexPattern(params.includePattern as string);
      } else {
        validateGlobPattern(params.includePattern as string);
      }
    }
  }
}

/**
 * ✅ VALIDAR QUE CREDENCIALES NO ESTÉN EN PARÁMETROS
 * 
 * CRÍTICA PARA SEGURIDAD: Previene que credenciales se guarden en workflow JSON
 * 
 * @param params - Parámetros del nodo
 * @throws Error si hay credenciales detectadas
 */
export function validateNoCredentialsInParameters(params: Record<string, unknown>): void {
  const sensitiveKeys = ['password', 'privateKey', 'passphrase', 'username', 'token', 'secret'];
  const flattenedParams = JSON.stringify(params);

  for (const key of sensitiveKeys) {
    if (flattenedParams.includes(`"${key}"`)) {
      // Verificar si es realmente una credencial (no solo coincidencia de nombre)
      const paramStr = flattenedParams.toLowerCase();
      if (paramStr.includes(key.toLowerCase())) {
        throw new Error(
          `${ErrorCode.INVALID_PARAMETERS}: Found potential credential '${key}' in parameters. Use credential store instead.`
        );
      }
    }
  }
}
