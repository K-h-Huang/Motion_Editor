import type {
  CsvMotionLoadResult,
  DroppedFileMap,
  MotionClip,
  MotionCsvMode,
  MotionSchema,
} from '../../types/viewer';
import {
  DEFAULT_MOTION_FPS,
  DEFAULT_ROOT_COMPONENT_COUNT,
  DEFAULT_ROOT_JOINT_NAME,
} from './MotionSchema';
import { getBaseName, getPathDepth, normalizePath } from '../urdf/pathResolver';

interface ParseStrategy {
  mode: MotionCsvMode;
  sourceColumnCount: number;
  mappedColumnIndices: number[];
}

const ROOT_HEADER_ALIASES: ReadonlyArray<ReadonlyArray<string>> = [
  ['root_x', 'x'],
  ['root_y', 'y'],
  ['root_z', 'z'],
  ['root_qx', 'qx'],
  ['root_qy', 'qy'],
  ['root_qz', 'qz'],
  ['root_qw', 'qw'],
];

function sortCsvPaths(paths: string[]): string[] {
  return [...paths]
    .map((path) => normalizePath(path))
    .filter(Boolean)
    .sort((left, right) => {
      const depthDelta = getPathDepth(left) - getPathDepth(right);
      if (depthDelta !== 0) {
        return depthDelta;
      }

      return left.localeCompare(right);
    });
}

function parseCsvLine(line: string): string[] {
  return line.split(',').map((token) => token.trim());
}

function isHeaderRow(tokens: string[]): boolean {
  return tokens.some((token) => !Number.isFinite(Number(token)));
}

function buildClipName(path: string): string {
  const baseName = getBaseName(path);
  return baseName || 'motion.csv';
}

function normalizeColumnName(value: string): string {
  return value.trim().toLowerCase();
}

function cloneMotionSchema(motionSchema: MotionSchema): MotionSchema {
  return {
    rootJointName: motionSchema.rootJointName || DEFAULT_ROOT_JOINT_NAME,
    rootComponentCount: motionSchema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames: [...motionSchema.jointNames],
  };
}

function findHeaderIndex(
  normalizedHeader: string[],
  aliases: readonly string[],
  usedIndices: Set<number>,
): number {
  for (const alias of aliases) {
    const normalizedAlias = normalizeColumnName(alias);
    for (let index = 0; index < normalizedHeader.length; index += 1) {
      if (usedIndices.has(index)) {
        continue;
      }

      if (normalizedHeader[index] === normalizedAlias) {
        return index;
      }
    }
  }

  return -1;
}

function formatMissingJointMessage(missingJointNames: string[]): string {
  const MAX_DISPLAY = 12;
  const displayed = missingJointNames.slice(0, MAX_DISPLAY).join(', ');
  const hiddenCount = Math.max(0, missingJointNames.length - MAX_DISPLAY);

  if (hiddenCount === 0) {
    return `CSV is incompatible with current URDF. Missing non-fixed joints: ${displayed}.`;
  }

  return `CSV is incompatible with current URDF. Missing non-fixed joints: ${displayed}, and ${hiddenCount} more.`;
}

function buildHeaderStrategy(
  headerTokens: string[],
  motionSchema: MotionSchema,
  warnings: Set<string>,
): ParseStrategy {
  const normalizedHeader = headerTokens.map((token) => normalizeColumnName(token));
  const usedIndices = new Set<number>();
  const mappedColumnIndices: number[] = [];

  for (const aliases of ROOT_HEADER_ALIASES) {
    const rootIndex = findHeaderIndex(normalizedHeader, aliases, usedIndices);
    if (rootIndex < 0) {
      throw new Error(
        'CSV header is missing required root columns. Expected root_x/root_y/root_z/root_qx/root_qy/root_qz/root_qw (or x/y/z/qx/qy/qz/qw).',
      );
    }

    usedIndices.add(rootIndex);
    mappedColumnIndices.push(rootIndex);
  }

  const missingJointNames: string[] = [];
  for (const jointName of motionSchema.jointNames) {
    const jointIndex = findHeaderIndex(
      normalizedHeader,
      [normalizeColumnName(jointName)],
      usedIndices,
    );
    if (jointIndex < 0) {
      missingJointNames.push(jointName);
      continue;
    }

    usedIndices.add(jointIndex);
    mappedColumnIndices.push(jointIndex);
  }

  if (missingJointNames.length > 0) {
    throw new Error(formatMissingJointMessage(missingJointNames));
  }

  const unmappedColumns: string[] = [];
  for (let index = 0; index < headerTokens.length; index += 1) {
    if (!usedIndices.has(index)) {
      unmappedColumns.push(headerTokens[index] || `col_${index + 1}`);
    }
  }

  if (unmappedColumns.length > 0) {
    warnings.add(
      `CSV contains ${unmappedColumns.length} unmapped columns and they were ignored: ${unmappedColumns.join(', ')}.`,
    );
  }

  return {
    mode: 'header',
    sourceColumnCount: headerTokens.length,
    mappedColumnIndices,
  };
}

function buildOrderedStrategy(
  firstDataRowTokens: string[],
  motionSchema: MotionSchema,
  warnings: Set<string>,
): ParseStrategy {
  const expectedStride = motionSchema.rootComponentCount + motionSchema.jointNames.length;
  const columnCount = firstDataRowTokens.length;
  if (columnCount < expectedStride) {
    throw new Error(
      `CSV has ${columnCount} columns, expected at least ${expectedStride} (${motionSchema.rootComponentCount} root + ${motionSchema.jointNames.length} non-fixed joints).`,
    );
  }

  if (columnCount > expectedStride) {
    warnings.add(
      `CSV has ${columnCount - expectedStride} extra joint columns; ignored tail columns.`,
    );
  }

  return {
    mode: 'ordered',
    sourceColumnCount: columnCount,
    mappedColumnIndices: Array.from({ length: expectedStride }, (_, index) => index),
  };
}

export class CsvMotionService {
  getAvailableCsvPaths(fileMap: DroppedFileMap): string[] {
    return sortCsvPaths(
      [...fileMap.keys()].filter((path) => path.toLowerCase().endsWith('.csv')),
    );
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    motionSchema: MotionSchema,
    preferredCsvPath?: string,
  ): Promise<CsvMotionLoadResult> {
    const csvPaths = this.getAvailableCsvPaths(fileMap);
    let selectedCsvPath: string | null = null;

    if (preferredCsvPath) {
      const normalizedPreferredPath = normalizePath(preferredCsvPath);
      selectedCsvPath =
        csvPaths.find((path) => path === normalizedPreferredPath) ?? null;
      if (!selectedCsvPath) {
        throw new Error(`Requested CSV not found in dropped files: ${preferredCsvPath}`);
      }
    } else {
      selectedCsvPath = csvPaths.length > 0 ? csvPaths[0] : null;
    }

    if (!selectedCsvPath) {
      throw new Error('No CSV file found. Drop a motion CSV file.');
    }

    const selectedFile = fileMap.get(selectedCsvPath);
    if (!selectedFile) {
      throw new Error(`Selected CSV file is missing from file map: ${selectedCsvPath}`);
    }

    const warnings = new Set<string>();
    if (!preferredCsvPath && csvPaths.length > 1) {
      warnings.add(
        `Multiple CSV files found. Auto-selected ${selectedCsvPath}. Drop target CSV to choose another.`,
      );
    }

    const csvContent = await selectedFile.text();
    const parsed = parseMotionCsv(csvContent, selectedCsvPath, motionSchema);
    for (const warning of parsed.warnings) {
      warnings.add(warning);
    }

    return {
      clip: parsed.clip,
      selectedCsvPath,
      warnings: [...warnings],
    };
  }

  toCsv(clip: any, robotHeight: number = 0): string {
    console.log('CsvMotionService.toCsv called with clip:', clip, 'robotHeight:', robotHeight);
    const lines: string[] = [];

    for (let frameIndex = 0; frameIndex < clip.frameCount; frameIndex++) {
      const base = frameIndex * clip.stride;
      const row: string[] = [];
      for (let i = 0; i < clip.stride; i++) {
        let value = clip.data[base + i];
        // 调整root z轴值（假设z轴是第3个分量，索引为2）
        if (i === 2) { // root_z
          const originalValue = value;
          value += robotHeight;
          console.log(`Frame ${frameIndex}: root_z original=${originalValue}, height=${robotHeight}, adjusted=${value}`);
        }
        row.push(String(parseFloat(value)));
      }
      lines.push(row.join(','));
    }
    console.log(`Created ${lines.length} lines`);

    return lines.join('\n');
  }
}

export interface ParseMotionCsvResult {
  clip: MotionClip;
  warnings: string[];
}

export function parseMotionCsv(
  content: string,
  sourcePath: string,
  motionSchema: MotionSchema,
): ParseMotionCsvResult {
  const schema = cloneMotionSchema(motionSchema);
  const lines = content.split(/\r?\n/);
  const values: number[] = [];
  const warnings = new Set<string>();
  let rowCount = 0;
  let parseStrategy: ParseStrategy | null = null;
  let hasAnyContent = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    if (!rawLine || rawLine.trim() === '') {
      continue;
    }

    hasAnyContent = true;
    const tokens = parseCsvLine(rawLine);
    const lineNumber = lineIndex + 1;

    if (!parseStrategy) {
      if (isHeaderRow(tokens)) {
        parseStrategy = buildHeaderStrategy(tokens, schema, warnings);
        warnings.add(`Detected CSV header row at line ${lineNumber} and skipped it.`);
        continue;
      }

      parseStrategy = buildOrderedStrategy(tokens, schema, warnings);
    }

    if (tokens.length !== parseStrategy.sourceColumnCount) {
      throw new Error(
        `CSV row ${lineNumber} has ${tokens.length} columns, expected ${parseStrategy.sourceColumnCount}.`,
      );
    }

    for (let columnIndex = 0; columnIndex < parseStrategy.mappedColumnIndices.length; columnIndex += 1) {
      const sourceColumnIndex = parseStrategy.mappedColumnIndices[columnIndex];
      const token = tokens[sourceColumnIndex];
      const value = Number(token);
      if (!Number.isFinite(value)) {
        throw new Error(
          `CSV row ${lineNumber}, col ${sourceColumnIndex + 1} is not a valid number: "${token}".`,
        );
      }

      values.push(value);
    }

    rowCount += 1;
  }

  if (!hasAnyContent) {
    throw new Error('CSV is empty.');
  }

  if (!parseStrategy || rowCount === 0) {
    throw new Error('CSV does not contain motion frames.');
  }

  const clip: MotionClip = {
    name: buildClipName(sourcePath),
    sourcePath: normalizePath(sourcePath),
    fps: DEFAULT_MOTION_FPS,
    frameCount: rowCount,
    stride: parseStrategy.mappedColumnIndices.length,
    schema,
    csvMode: parseStrategy.mode,
    sourceColumnCount: parseStrategy.sourceColumnCount,
    data: new Float32Array(values),
  };

  return {
    clip,
    warnings: [...warnings],
  };
}

