import type { DroppedFileMap, MotionClip, MotionSchema } from '../../types/viewer';
import { DEFAULT_MOTION_FPS, DEFAULT_ROOT_COMPONENT_COUNT } from './MotionSchema';
import { getBaseName, normalizePath } from '../urdf/pathResolver';
import {
  parsePickleNdarrayFloat64,
  parsePythonPickleBuffer,
} from './PythonPickleIO';
import { pickle } from 'picklefriend';

interface ParsedGmrMotionPayload {
  name: string;
  sourcePath: string;
  fps: number;
  frameCount: number;
  jointCount: number;
  rootPos: Float64Array;
  rootRot: Float64Array;
  dofPos: Float64Array;
  linkBodyList: string[];
  warnings: string[];
}

export interface GmrMotionLoadResult {
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
    return null;
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

function parseGmrNdarray(
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

function parseStringArray(value: unknown, label: string): string[] {
  if (value === null || value === undefined) {
    throw new Error(`${label} must be an array, but got ${value}.`);
  }
  if (!Array.isArray(value)) {
    // 如果不是数组，尝试转换为数组
    if (typeof value === 'string') {
      // 如果是字符串，按逗号分割
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    // 否则抛出错误
    throw new Error(`${label} must be an array, but got ${typeof value}.`);
  }
  return value.map((item) => String(item ?? ''));
}

async function parseGmrMotionPayload(
  file: File,
  sourcePath: string,
): Promise<ParsedGmrMotionPayload> {
  const buffer = await file.arrayBuffer();
  let parsed: unknown;
  try {
    parsed = parsePythonPickleBuffer(buffer);
  } catch (error) {
    throw new Error(`Failed to parse GMR PKL with pickleparser: ${toErrorMessage(error)}.`);
  }

  if (!isRecord(parsed)) {
    throw new Error('GMR PKL root object must be a dictionary.');
  }

  if (parsed.fps === undefined) {
    throw new Error('GMR PKL is missing "fps".');
  }
  if (parsed.root_pos === undefined) {
    throw new Error('GMR PKL is missing "root_pos".');
  }
  if (parsed.root_rot === undefined) {
    throw new Error('GMR PKL is missing "root_rot".');
  }
  if (parsed.dof_pos === undefined) {
    throw new Error('GMR PKL is missing "dof_pos".');
  }

  const warnings: string[] = [];

  const parsedFps = parsePositiveFps(parsed.fps);
  const fps = parsedFps ?? DEFAULT_MOTION_FPS;
  if (!parsedFps) {
    warnings.push(
      `GMR motion "${sourcePath}" has invalid fps; defaulted to ${DEFAULT_MOTION_FPS}.`,
    );
  }

  const rootPos = parseGmrNdarray(parsed.root_pos, 'root_pos');
  if (rootPos.shape.length !== 2 || rootPos.shape[1] !== 3) {
    throw new Error(
      `GMR root_pos must be a 2D array with shape [frameCount, 3], received [${rootPos.shape.join(', ')}].`,
    );
  }

  const rootRot = parseGmrNdarray(parsed.root_rot, 'root_rot');
  if (rootRot.shape.length !== 2 || rootRot.shape[1] !== 4) {
    throw new Error(
      `GMR root_rot must be a 2D array with shape [frameCount, 4], received [${rootRot.shape.join(', ')}].`,
    );
  }

  const dofPos = parseGmrNdarray(parsed.dof_pos, 'dof_pos');
  if (dofPos.shape.length !== 2) {
    throw new Error(
      `GMR dof_pos must be a 2D array, received [${dofPos.shape.join(', ')}].`,
    );
  }

  let linkBodyList: string[] = [];
  if (parsed.link_body_list !== null && parsed.link_body_list !== undefined) {
    linkBodyList = parseStringArray(parsed.link_body_list, 'link_body_list');
  } else {
    warnings.push('GMR PKL has null or undefined link_body_list, using empty array.');
  }

  const frameCount = rootPos.shape[0];
  const jointCount = dofPos.shape[1];

  if (frameCount <= 0) {
    throw new Error('GMR motion has no frames.');
  }

  if (frameCount !== rootRot.shape[0] || frameCount !== dofPos.shape[0]) {
    throw new Error(
      `GMR motion frame count mismatch: root_pos=${rootPos.shape[0]}, root_rot=${rootRot.shape[0]}, dof_pos=${dofPos.shape[0]}.`,
    );
  }

  if (linkBodyList.length > 0 && jointCount !== linkBodyList.length) {
    warnings.push(
      `GMR joint count mismatch: dof_pos has ${jointCount} joints, link_body_list has ${linkBodyList.length} entries.`,
    );
  }

  return {
    name: buildClipName(sourcePath),
    sourcePath,
    fps,
    frameCount,
    jointCount,
    rootPos: rootPos.values,
    rootRot: rootRot.values,
    dofPos: dofPos.values,
    linkBodyList,
    warnings,
  };
}

function cloneMotionSchema(motionSchema: MotionSchema, linkBodyList: string[]): MotionSchema {
  return {
    rootJointName: motionSchema.rootJointName,
    rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames: linkBodyList.length > 0 ? [...linkBodyList] : [...motionSchema.jointNames],
  };
}

function buildMotionClip(
  payload: ParsedGmrMotionPayload,
  motionSchema: MotionSchema,
): MotionClip {
  const expectedJointCount = motionSchema.jointNames.length;
  if (payload.jointCount !== expectedJointCount) {
    throw new Error(
      `GMR motion "${payload.sourcePath}" has ${payload.jointCount} joints, expected ${expectedJointCount} for the active URDF.`,
    );
  }

  const stride = DEFAULT_ROOT_COMPONENT_COUNT + expectedJointCount;
  const data = new Float32Array(payload.frameCount * stride);

  for (let frameIndex = 0; frameIndex < payload.frameCount; frameIndex += 1) {
    const targetBase = frameIndex * stride;
    const rootPosBase = frameIndex * 3;
    const rootRotBase = frameIndex * 4;
    const dofPosBase = frameIndex * payload.jointCount;

    const x = payload.rootPos[rootPosBase] ?? 0;
    const y = payload.rootPos[rootPosBase + 1] ?? 0;
    const z = payload.rootPos[rootPosBase + 2] ?? 0;

    let qx = payload.rootRot[rootRotBase] ?? 0;
    let qy = payload.rootRot[rootRotBase + 1] ?? 0;
    let qz = payload.rootRot[rootRotBase + 2] ?? 0;
    let qw = payload.rootRot[rootRotBase + 3] ?? 0;

    const qLen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (qLen < 1e-10) {
      qx = 0;
      qy = 0;
      qz = 0;
      qw = 1;
    } else {
      qx /= qLen;
      qy /= qLen;
      qz /= qLen;
      qw /= qLen;
    }

    data[targetBase] = x;
    data[targetBase + 1] = y;
    data[targetBase + 2] = z;
    data[targetBase + 3] = qx;
    data[targetBase + 4] = qy;
    data[targetBase + 5] = qz;
    data[targetBase + 6] = qw;

    for (let jointIndex = 0; jointIndex < expectedJointCount; jointIndex += 1) {
      data[targetBase + DEFAULT_ROOT_COMPONENT_COUNT + jointIndex] =
        payload.dofPos[dofPosBase + jointIndex] ?? 0;
    }
  }

  return {
    name: payload.name,
    sourcePath: payload.sourcePath,
    fps: payload.fps,
    frameCount: payload.frameCount,
    stride,
    schema: cloneMotionSchema(motionSchema, payload.linkBodyList),
    csvMode: 'ordered',
    sourceColumnCount: DEFAULT_ROOT_COMPONENT_COUNT + payload.jointCount,
    data,
  };
}

export class GmrMotionService {
  getAvailablePklPaths(fileMap: DroppedFileMap): string[] {
    return [...fileMap.keys()]
      .map((path) => normalizePath(path))
      .filter((path) => {
        const normalized = path.toLowerCase();
        return normalized.endsWith('.pkl');
      })
      .sort((left, right) => left.localeCompare(right));
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    motionSchema: MotionSchema,
    preferredMotionPath?: string,
  ): Promise<GmrMotionLoadResult> {
    const pklPaths = this.getAvailablePklPaths(fileMap);
    if (pklPaths.length === 0) {
      throw new Error('No GMR motion .pkl found. Drop a motion .pkl file.');
    }

    const expectedJointCount = motionSchema.jointNames.length;
    const warnings = new Set<string>();

    const loadPath = async (path: string): Promise<ParsedGmrMotionPayload> => {
      const file = fileMap.get(path);
      if (!file) {
        throw new Error(`Selected GMR motion is missing from file map: ${path}`);
      }
      return parseGmrMotionPayload(file, path);
    };

    if (preferredMotionPath) {
      const normalizedPreferredPath = normalizePath(preferredMotionPath);
      const selectedPath = pklPaths.find((path) => path === normalizedPreferredPath) ?? null;
      if (!selectedPath) {
        throw new Error(`Requested GMR motion not found in dropped files: ${preferredMotionPath}`);
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
    let selectedPayload: ParsedGmrMotionPayload | null = null;
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
          `No GMR motion is compatible with the active URDF. Expected ${expectedJointCount} joints, found ${[...discoveredJointCounts].sort((left, right) => left - right).join(', ')}.`,
        );
      }

      throw new Error(firstParseError ?? 'No valid GMR motion .pkl found.');
    }

    if (invalidFileCount > 0) {
      warnings.add(
        `Ignored ${invalidFileCount} unsupported .pkl file${invalidFileCount > 1 ? 's' : ''} while scanning for GMR motions.`,
      );
    }

    for (const warning of selectedPayload.warnings) {
      warnings.add(warning);
    }

    if (pklPaths.length > 1) {
      if (selectedPath === pklPaths[0]) {
        warnings.add(
          `Multiple GMR motion files found. Auto-selected ${selectedPath}. Drop target PKL to choose another.`,
        );
      } else {
        warnings.add(
          `Multiple GMR motion files found. Auto-selected ${selectedPath} based on active URDF joint count (${expectedJointCount}).`,
        );
      }
    }

    return {
      clip: buildMotionClip(selectedPayload, motionSchema),
      selectedMotionPath: selectedPath,
      warnings: [...warnings],
    };
  }

  toGmrPkl(clip: MotionClip): string {
    const { data, frameCount, fps, schema } = clip;
    const jointCount = schema.jointNames.length;
    const stride = DEFAULT_ROOT_COMPONENT_COUNT + jointCount;

    // Extract root positions (x, y, z) for each frame
    const rootPos: number[][] = [];
    // Extract root rotations (x, y, z, w) for each frame
    const rootRot: number[][] = [];
    // Extract joint positions for each frame
    const dofPos: number[][] = [];

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const baseIndex = frameIndex * stride;
      
      // Root position (x, y, z)
      rootPos.push([
        data[baseIndex],
        data[baseIndex + 1],
        data[baseIndex + 2]
      ]);

      // Root rotation (x, y, z, w)
      rootRot.push([
        data[baseIndex + 3],
        data[baseIndex + 4],
        data[baseIndex + 5],
        data[baseIndex + 6]
      ]);

      // Joint positions
      const jointPositions: number[] = [];
      for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
        jointPositions.push(data[baseIndex + DEFAULT_ROOT_COMPONENT_COUNT + jointIndex]);
      }
      dofPos.push(jointPositions);
    }

    // Create the GMR pickle structure exactly as requested
    const gmrData = {
      fps,
      root_pos: rootPos,
      root_rot: rootRot,
      dof_pos: dofPos,
      local_body_pos: null,
      link_body_list: schema.jointNames
    };

    // Serialize to pickle format
    return pickle.dumps(gmrData);
  }
}
