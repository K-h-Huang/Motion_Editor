import type { DroppedFileMap, MotionClip, MotionSchema } from '../../types/viewer';
import { DEFAULT_MOTION_FPS, DEFAULT_ROOT_COMPONENT_COUNT } from './MotionSchema';
import { getBaseName, getPathDepth, normalizePath } from '../urdf/pathResolver';
import {
  parsePickleNdarrayFloat64,
  parsePythonPickleBuffer,
} from './PythonPickleIO';
import { pickle } from 'picklefriend';

const MIMICKIT_SOURCE_ROOT_COMPONENT_COUNT = 6; // XYZ + root expmap XYZ

interface ParsedMimicKitMotionPayload {
  name: string;
  sourcePath: string;
  fps: number;
  frameCount: number;
  sourceColumnCount: number;
  jointCount: number;
  frameValues: Float64Array;
  warnings: string[];
}

export interface MimicKitMotionLoadResult {
  clip: MotionClip;
  selectedMotionPath: string;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseFramesAsNestedNumberMatrix(
  value: unknown,
  label: string,
): {
  shape: [number, number];
  values: Float64Array;
} | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const rowCount = value.length;
  if (rowCount === 0) {
    return {
      shape: [0, 0],
      values: new Float64Array(0),
    };
  }

  const firstRow = value[0];
  if (!Array.isArray(firstRow)) {
    throw new Error(`${label} must be a 2D numeric matrix.`);
  }

  const columnCount = firstRow.length;
  const output = new Float64Array(rowCount * columnCount);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = value[rowIndex];
    if (!Array.isArray(row) || row.length !== columnCount) {
      throw new Error(`${label} must be a rectangular 2D numeric matrix.`);
    }

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const numericValue = Number(row[columnIndex]);
      if (!Number.isFinite(numericValue)) {
        throw new Error(`${label}[${rowIndex}][${columnIndex}] is not a finite number.`);
      }
      output[rowIndex * columnCount + columnIndex] = numericValue;
    }
  }

  return {
    shape: [rowCount, columnCount],
    values: output,
  };
}

function parseMimicKitFrames(
  value: unknown,
  label: string,
): {
  shape: number[];
  values: Float64Array;
} {
  const matrixPayload = parseFramesAsNestedNumberMatrix(value, label);
  if (matrixPayload) {
    return matrixPayload;
  }

  return parsePickleNdarrayFloat64(value, label);
}

function sortPklPaths(paths: string[]): string[] {
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

function isSmplModelPklPath(path: string): boolean {
  const baseName = getBaseName(path).toLowerCase();
  return baseName.endsWith('.pkl') && baseName.startsWith('basicmodel_');
}

function buildClipName(path: string): string {
  const baseName = getBaseName(path);
  return baseName || 'motion.pkl';
}

function parsePositiveFps(value: unknown): number | null {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    return null;
  }

  return fps;
}

function expMapToQuaternionComponents(
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  const angle = Math.hypot(x, y, z);
  const halfAngle = angle * 0.5;
  const scale =
    angle < 1e-8 ? 0.5 - (angle * angle) / 48 : Math.sin(halfAngle) / angle;

  return [x * scale, y * scale, z * scale, Math.cos(halfAngle)];
}

async function parseMimicKitMotionPayload(
  file: File,
  sourcePath: string,
): Promise<ParsedMimicKitMotionPayload> {
  const buffer = await file.arrayBuffer();
  let parsed: unknown;
  try {
    parsed = parsePythonPickleBuffer(buffer);
  } catch (error) {
    throw new Error(`Failed to parse MimicKit PKL with pickleparser: ${toErrorMessage(error)}.`);
  }

  if (!isRecord(parsed)) {
    throw new Error('MimicKit PKL root object must be a dictionary.');
  }

  if (parsed.frames === undefined) {
    throw new Error('MimicKit PKL is missing "frames".');
  }

  const frames = parseMimicKitFrames(parsed.frames, 'frames');
  if (frames.shape.length !== 2) {
    throw new Error(
      `MimicKit frames must be a 2D numeric matrix, received shape [${frames.shape.join(', ')}].`,
    );
  }

  const frameCount = frames.shape[0] ?? 0;
  const sourceColumnCount = frames.shape[1] ?? 0;
  if (frameCount <= 0) {
    throw new Error('MimicKit motion has no frames.');
  }
  if (sourceColumnCount <= MIMICKIT_SOURCE_ROOT_COMPONENT_COUNT) {
    throw new Error(
      `MimicKit motion frame width ${sourceColumnCount} is invalid; expected root pose + joints.`,
    );
  }

  const warnings: string[] = [];
  const parsedFps = parsePositiveFps(parsed.fps);
  const fps = parsedFps ?? DEFAULT_MOTION_FPS;
  if (!parsedFps) {
    warnings.push(
      `MimicKit motion "${sourcePath}" has invalid fps; defaulted to ${DEFAULT_MOTION_FPS}.`,
    );
  }

  return {
    name: buildClipName(sourcePath),
    sourcePath,
    fps,
    frameCount,
    sourceColumnCount,
    jointCount: sourceColumnCount - MIMICKIT_SOURCE_ROOT_COMPONENT_COUNT,
    frameValues: frames.values,
    warnings,
  };
}

function cloneMotionSchema(motionSchema: MotionSchema): MotionSchema {
  return {
    rootJointName: motionSchema.rootJointName,
    rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames: [...motionSchema.jointNames],
  };
}

function buildMotionClip(
  payload: ParsedMimicKitMotionPayload,
  motionSchema: MotionSchema,
): MotionClip {
  const expectedJointCount = motionSchema.jointNames.length;
  if (payload.jointCount !== expectedJointCount) {
    throw new Error(
      `MimicKit motion "${payload.sourcePath}" has ${payload.jointCount} joints, expected ${expectedJointCount} for the active URDF.`,
    );
  }

  const stride = DEFAULT_ROOT_COMPONENT_COUNT + expectedJointCount;
  const data = new Float32Array(payload.frameCount * stride);

  for (let frameIndex = 0; frameIndex < payload.frameCount; frameIndex += 1) {
    const sourceBase = frameIndex * payload.sourceColumnCount;
    const targetBase = frameIndex * stride;

    const x = payload.frameValues[sourceBase] ?? 0;
    const y = payload.frameValues[sourceBase + 1] ?? 0;
    const z = payload.frameValues[sourceBase + 2] ?? 0;
    const rx = payload.frameValues[sourceBase + 3] ?? 0;
    const ry = payload.frameValues[sourceBase + 4] ?? 0;
    const rz = payload.frameValues[sourceBase + 5] ?? 0;
    const [qx, qy, qz, qw] = expMapToQuaternionComponents(rx, ry, rz);

    data[targetBase] = x;
    data[targetBase + 1] = y;
    data[targetBase + 2] = z;
    data[targetBase + 3] = qx;
    data[targetBase + 4] = qy;
    data[targetBase + 5] = qz;
    data[targetBase + 6] = qw;

    for (let jointIndex = 0; jointIndex < expectedJointCount; jointIndex += 1) {
      data[targetBase + DEFAULT_ROOT_COMPONENT_COUNT + jointIndex] =
        payload.frameValues[sourceBase + MIMICKIT_SOURCE_ROOT_COMPONENT_COUNT + jointIndex] ?? 0;
    }
  }

  return {
    name: payload.name,
    sourcePath: payload.sourcePath,
    fps: payload.fps,
    frameCount: payload.frameCount,
    stride,
    schema: cloneMotionSchema(motionSchema),
    csvMode: 'ordered',
    sourceColumnCount: payload.sourceColumnCount,
    data,
  };
}

export class MimicKitMotionService {
  getAvailablePklPaths(fileMap: DroppedFileMap): string[] {
    return sortPklPaths(
      [...fileMap.keys()].filter((path) => {
        const normalized = normalizePath(path).toLowerCase();
        return normalized.endsWith('.pkl') && !isSmplModelPklPath(path);
      }),
    );
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    motionSchema: MotionSchema,
    preferredMotionPath?: string,
  ): Promise<MimicKitMotionLoadResult> {
    const pklPaths = this.getAvailablePklPaths(fileMap);
    if (pklPaths.length === 0) {
      throw new Error('No MimicKit motion .pkl found. Drop a motion .pkl file.');
    }

    const expectedJointCount = motionSchema.jointNames.length;
    const warnings = new Set<string>();

    const loadPath = async (path: string): Promise<ParsedMimicKitMotionPayload> => {
      const file = fileMap.get(path);
      if (!file) {
        throw new Error(`Selected MimicKit motion is missing from file map: ${path}`);
      }
      return parseMimicKitMotionPayload(file, path);
    };

    if (preferredMotionPath) {
      const normalizedPreferredPath = normalizePath(preferredMotionPath);
      const selectedPath = pklPaths.find((path) => path === normalizedPreferredPath) ?? null;
      if (!selectedPath) {
        throw new Error(`Requested MimicKit motion not found in dropped files: ${preferredMotionPath}`);
      }

      const payload = await loadPath(selectedPath);
      const clip = buildMotionClip(payload, motionSchema);
      for (const warning of payload.warnings) {
        warnings.add(warning);
      }

      return {
        clip,
        selectedMotionPath: selectedPath,
        warnings: [...warnings],
      };
    }

    let invalidFileCount = 0;
    const discoveredJointCounts = new Set<number>();
    let selectedPath: string | null = null;
    let selectedPayload: ParsedMimicKitMotionPayload | null = null;
    let firstParseError: string | null = null;

    for (const path of pklPaths) {
      try {
        const payload = await loadPath(path);
        discoveredJointCounts.add(payload.jointCount);

        if (payload.jointCount !== expectedJointCount) {
          continue;
        }

        selectedPath = path;
        selectedPayload = payload;
        break;
      } catch (error) {
        invalidFileCount += 1;
        firstParseError ??= toErrorMessage(error);
      }
    }

    if (!selectedPath || !selectedPayload) {
      if (discoveredJointCounts.size > 0) {
        throw new Error(
          `No MimicKit motion is compatible with the active URDF. Expected ${expectedJointCount} joints, found ${[...discoveredJointCounts].sort((left, right) => left - right).join(', ')}.`,
        );
      }

      throw new Error(firstParseError ?? 'No valid MimicKit motion .pkl found.');
    }

    if (invalidFileCount > 0) {
      warnings.add(
        `Ignored ${invalidFileCount} unsupported .pkl file${invalidFileCount > 1 ? 's' : ''} while scanning for MimicKit motions.`,
      );
    }

    for (const warning of selectedPayload.warnings) {
      warnings.add(warning);
    }

    if (pklPaths.length > 1) {
      if (selectedPath === pklPaths[0]) {
        warnings.add(
          `Multiple MimicKit motion files found. Auto-selected ${selectedPath}. Drop target PKL to choose another.`,
        );
      } else {
        warnings.add(
          `Multiple MimicKit motion files found. Auto-selected ${selectedPath} based on active URDF joint count (${expectedJointCount}).`,
        );
      }
    }

    return {
      clip: buildMotionClip(selectedPayload, motionSchema),
      selectedMotionPath: selectedPath,
      warnings: [...warnings],
    };
  }

  toMimicKitPkl(clip: MotionClip): string {
    const { data, frameCount, fps, schema } = clip;
    const jointCount = schema.jointNames.length;
    const stride = DEFAULT_ROOT_COMPONENT_COUNT + jointCount;

    // Extract frames data in MimicKit format
    const frames: number[][] = [];

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const baseIndex = frameIndex * stride;
      
      // Extract root position (x, y, z)
      const x = data[baseIndex];
      const y = data[baseIndex + 1];
      const z = data[baseIndex + 2];
      
      // Extract root rotation (quaternion x, y, z, w)
      const qx = data[baseIndex + 3];
      const qy = data[baseIndex + 4];
      const qz = data[baseIndex + 5];
      const qw = data[baseIndex + 6];
      
      // Convert quaternion to expmap
      const [rx, ry, rz] = quaternionToExpMap(qx, qy, qz, qw);
      
      // Build frame data: [x, y, z, rx, ry, rz, ...joint positions]
      const frame: number[] = [x, y, z, rx, ry, rz];
      
      // Add joint positions
      for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
        frame.push(data[baseIndex + DEFAULT_ROOT_COMPONENT_COUNT + jointIndex]);
      }
      
      frames.push(frame);
    }

    // Create the MimicKit pickle structure
    const mimicKitData = {
      frames,
      fps
    };

    // Serialize to pickle format
    return pickle.dumps(mimicKitData);
  }
}

function quaternionToExpMap(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
  // Convert quaternion to rotation vector (expmap)
  const angle = 2 * Math.acos(qw);
  const sinHalfAngle = Math.sin(angle / 2);
  
  if (Math.abs(sinHalfAngle) < 1e-8) {
    return [0, 0, 0];
  }
  
  const scale = angle / sinHalfAngle;
  return [qx * scale, qy * scale, qz * scale];
}
