/**
 * Motor de filtrado de archivos
 *
 * Evalúa archivos contra reglas de inclusión/exclusión usando
 * glob patterns o expresiones regulares.
 *
 * Principios de diseño:
 * - Las reglas de exclusión tienen prioridad sobre las de inclusión
 * - Sin reglas: todos los archivos son incluidos
 * - Múltiples reglas de inclusión: OR (basta con cumplir una)
 * - Múltiples reglas de exclusión: OR (basta con cumplir una para excluir)
 */

import { minimatch } from 'minimatch';
import { FilterPattern, RemoteFileInfo } from '../types/common.types';
import { validateGlobPattern, validateRegexPattern } from './validators';

export interface FilterResult {
  included: boolean;
  reason?: string;
  matchedRule?: FilterPattern;
}

export interface FilterSummary {
  totalEvaluated: number;
  included: number;
  excluded: number;
  byExtension: Record<string, number>;
}

/**
 * Motor de filtrado de archivos SFTP
 *
 * Evalúa si un archivo debe incluirse en la descarga basándose
 * en reglas de extensión, glob o regex.
 *
 * Orden de evaluación:
 * 1. Exclusiones explícitas (excluye si coincide con alguna)
 * 2. Inclusiones explícitas (incluye si coincide con alguna; si no hay→incluye todo)
 * 3. Filtro por extensión
 */
export class FilterEngine {
  private readonly patterns: FilterPattern[];
  private readonly compiledRegexes = new Map<string, RegExp>();

  constructor(patterns: FilterPattern[] = []) {
    for (const p of patterns) {
      if (p.patternType === 'glob') {
        validateGlobPattern(p.pattern);
      } else {
        this.compiledRegexes.set(p.pattern, validateRegexPattern(p.pattern));
      }
    }
    this.patterns = patterns;
  }

  /**
   * Evaluar si un archivo debe incluirse
   *
   * @param filename - Nombre del archivo a evaluar
   * @returns FilterResult
   */
  evaluate(filename: string): FilterResult {
    const includeRules = this.patterns.filter((p) => p.type === 'include');
    const excludeRules = this.patterns.filter((p) => p.type === 'exclude');

    // 1. Verificar exclusiones (tienen prioridad)
    for (const rule of excludeRules) {
      if (this.matches(filename, rule)) {
        return {
          included: false,
          reason: `Excluded by rule: ${rule.pattern}`,
          matchedRule: rule,
        };
      }
    }

    // 2. Verificar inclusiones
    if (includeRules.length > 0) {
      for (const rule of includeRules) {
        if (this.matches(filename, rule)) {
          return {
            included: true,
            reason: `Included by rule: ${rule.pattern}`,
            matchedRule: rule,
          };
        }
      }
      // Hay reglas de inclusión pero ninguna coincidió
      return {
        included: false,
        reason: 'No inclusion rule matched',
      };
    }

    // 3. Sin reglas de inclusión → incluir todo
    return { included: true, reason: 'No filter rules, include all' };
  }

  /**
   * Filtrar lista de archivos
   *
   * @param files - Lista de archivos remotos a filtrar
   * @returns Array con los archivos incluidos
   */
  filter(files: RemoteFileInfo[]): RemoteFileInfo[] {
    return files.filter((file) => {
      const result = this.evaluate(file.filename);
      return result.included;
    });
  }

  /**
   * Evaluar lista y devolver resultados detallados
   */
  evaluateAll(files: RemoteFileInfo[]): Array<{ file: RemoteFileInfo; result: FilterResult }> {
    return files.map((file) => ({
      file,
      result: this.evaluate(file.filename),
    }));
  }

  /**
   * Producir resumen de filtrado
   */
  summarize(files: RemoteFileInfo[]): FilterSummary {
    const results = this.evaluateAll(files);

    const included = results.filter((r) => r.result.included).length;
    const byExtension: Record<string, number> = {};

    for (const { file, result } of results) {
      if (result.included) {
        const ext = getExtension(file.filename);
        byExtension[ext] = (byExtension[ext] || 0) + 1;
      }
    }

    return {
      totalEvaluated: files.length,
      included,
      excluded: files.length - included,
      byExtension,
    };
  }

  /**
   * Verificar si un nombre de archivo coincide con un patrón
   */
  private matches(filename: string, rule: FilterPattern): boolean {
    if (rule.patternType === 'glob') {
      return minimatch(filename, rule.pattern, { nocase: false, dot: false });
    }
    return this.compiledRegexes.get(rule.pattern)!.test(filename);
  }
}

// ---------------------------------------------------------------------------
// Factories utilitarias
// ---------------------------------------------------------------------------

/**
 * Crear motor de filtrado por extensión de archivo
 *
 * @param extension - Extensión incluyendo punto (ej: '.csv')
 */
export function createExtensionFilter(extension: string): FilterEngine {
  const normalized = extension.startsWith('.') ? extension : `.${extension}`;
  return new FilterEngine([
    {
      type: 'include',
      patternType: 'glob',
      pattern: `*${normalized}`,
    },
  ]);
}

/**
 * Crear motor de filtrado por patrón único (glob o regex)
 *
 * @param patternType - 'glob' | 'regex'
 * @param includePattern - Patrón de inclusión
 * @param excludePattern - Patrón de exclusión opcional
 */
export function createPatternFilter(
  patternType: 'glob' | 'regex',
  includePattern?: string,
  excludePattern?: string
): FilterEngine {
  const rules: FilterPattern[] = [];

  if (includePattern) {
    rules.push({ type: 'include', patternType, pattern: includePattern });
  }
  if (excludePattern) {
    rules.push({ type: 'exclude', patternType, pattern: excludePattern });
  }

  return new FilterEngine(rules);
}

/**
 * Crear motor de filtrado desde múltiples reglas
 *
 * @param patterns - Array de reglas de filtrado
 */
export function createMultiPatternFilter(patterns: FilterPattern[]): FilterEngine {
  return new FilterEngine(patterns);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  return filename.slice(idx);
}

/**
 * Verificar si un archivo pasa el filtro de tamaño
 *
 * @param fileSizeBytes - Tamaño del archivo en bytes
 * @param maxFileSizeMB - Límite en MB (0 = sin límite)
 * @returns true si el archivo está dentro del límite
 */
export function passSizeFilter(fileSizeBytes: number, maxFileSizeMB: number): boolean {
  if (maxFileSizeMB === 0) return true;
  const maxBytes = maxFileSizeMB * 1024 * 1024;
  return fileSizeBytes <= maxBytes;
}
