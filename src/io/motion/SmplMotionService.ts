import {
  Bone,
  MeshStandardMaterial,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  SkeletonHelper,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';

import type { DroppedFileMap } from '../../types/viewer';
import { getBaseName, getPathDepth, normalizePath } from '../urdf/pathResolver';
import { parseNpzFile, type ParsedNpyArray } from './NumpyIO';
import { parseSmplWebuserPkl, type ParsedSmplWebuserPkl } from './PythonPickleIO';

const REQUIRED_MODEL_ENTRIES = [
  'v_template.npy',
  'shapedirs.npy',
  'weights.npy',
  'kintree_table.npy',
  'J_regressor.npy',
  'f.npy',
] as const;

const REQUIRED_MOTION_ENTRIES = ['poses.npy', 'trans.npy'] as const;
const SKELETON_HIGHLIGHT_COLOR = '#7ef9ff';
const OMOMO_TRANS_TO_JOINT_FALLBACK_ALL: [number, number, number] = [-0.0011, 0.3795, -0.0194];
const OMOMO_TRANS_TO_JOINT_FALLBACK_BY_GENDER: Record<
  Exclude<SmplGender, 'neutral'>,
  [number, number, number]
> = {
  male: [-0.00137408, 0.39028805, -0.01708837],
  female: [-0.00059544, 0.3626442, -0.02312135],
};
const OMOMO_SEQUENCE_NAME_PATTERN = /^sub\d+_[a-z0-9]+_\d+$/i;

type SmplGender = 'male' | 'female' | 'neutral';

interface SmplModelData {
  vertexCount: number;
  jointCount: number;
  parentIndices: Int32Array;
  jointRestPositions: Float32Array;
  shapedVertices: Float32Array;
  faces: Uint32Array;
  weights: Float32Array;
  availableBetas: number;
}

interface SmplRigData {
  sceneObject: any;
  rootGroup: any;
  skinnedMesh: any;
  skeletonHelper: any;
  bones: any[];
}

export interface SmplObjectMotionTrack {
  frameCount: number;
  trans: Float32Array;
  rotMat: Float32Array | null;
  scale: Float32Array | null;
}

export interface SmplPlaybackTarget {
  rootGroup: any;
  bones: any[];
  objectRoot?: any;
}

export interface SmplMotionClip {
  name: string;
  sourcePath: string;
  frameCount: number;
  fps: number;
  jointCount: number;
  poseStride: number;
  poses: Float32Array;
  trans: Float32Array;
  translationOffsetXY: [number, number];
  objectMotion: SmplObjectMotionTrack | null;
  objectAlignmentOffset: [number, number, number] | null;
  objectName: string | null;
}

export interface SmplMotionLoadResult {
  selectedModelPath: string;
  selectedMotionPath: string;
  availableModelPaths: string[];
  sceneObject: any;
  playbackTarget: SmplPlaybackTarget;
  clip: SmplMotionClip;
  modelName: string;
  motionName: string;
  objectName: string | null;
  frameCount: number;
  fps: number;
  vertexCount: number;
  jointCount: number;
  motionGender: SmplGender | null;
  modelGender: SmplGender | null;
  hasObjectMotion: boolean;
  warnings: string[];
}

export interface SmplModelLoadResult {
  selectedModelPath: string;
  availableModelPaths: string[];
  sceneObject: any;
  playbackTarget: SmplPlaybackTarget;
  modelName: string;
  modelGender: SmplGender | null;
  vertexCount: number;
  jointCount: number;
  warnings: string[];
}

export interface SmplNpzScanResult {
  modelPaths: string[];
  motionPaths: string[];
  unknownNpzPaths: string[];
}

interface SmplModelRawPayload {
  vTemplateShape: number[];
  vTemplateValues: Float64Array;
  shapedirsShape: number[];
  shapedirsValues: Float64Array;
  weightsShape: number[];
  weightsValues: Float64Array;
  kintreeShape: number[];
  kintreeValues: Int32Array;
  regressorShape: number[];
  regressorValues: Float64Array;
  facesShape: number[];
  facesValues: Uint32Array;
}

function sortPaths(paths: string[]): string[] {
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

function buildDisplayName(path: string, fallback: string): string {
  return getBaseName(path) || fallback;
}

function normalizeObjectNameToken(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
  const core = normalized
    .replace(/_cleaned_simplified(?:_(top|bottom))?$/, '')
    .replace(/_(top|bottom)$/, '');
  return core || null;
}

function inferObjectNameFromSeqLikeName(rawName: string): string | null {
  const tokens = rawName
    .trim()
    .split('_')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length < 2) {
    return null;
  }

  if (/^sub\d+$/i.test(tokens[0] ?? '')) {
    return normalizeObjectNameToken(tokens[1] ?? '');
  }

  return normalizeObjectNameToken(tokens[1] ?? '');
}

function normalizeGenderToken(raw: string): SmplGender | null {
  const token = raw.trim().toLowerCase();
  if (!token) {
    return null;
  }

  if (token.includes('female') || token === 'f') {
    return 'female';
  }
  if (token.includes('male') || token === 'm') {
    return 'male';
  }
  if (token.includes('neutral') || token.includes('neuter') || token === 'n') {
    return 'neutral';
  }
  return null;
}

function inferModelGenderFromPath(path: string): SmplGender | null {
  const normalized = normalizePath(path).toLowerCase();
  if (
    /(^|[^a-z])female([^a-z]|$)/.test(normalized) ||
    /(?:^|[_/.-])f(?:[_/.-]|$)/.test(normalized)
  ) {
    return 'female';
  }
  if (
    /(^|[^a-z])male([^a-z]|$)/.test(normalized) ||
    /(?:^|[_/.-])m(?:[_/.-]|$)/.test(normalized)
  ) {
    return 'male';
  }
  if (/(^|[^a-z])neutral([^a-z]|$)/.test(normalized)) {
    return 'neutral';
  }
  return null;
}

function inferModelFamilyFromPath(path: string): 'smplx' | 'smplh' | 'smpl' | null {
  const normalized = normalizePath(path).toLowerCase();
  if (normalized.includes('/smplx/')) {
    return 'smplx';
  }
  if (normalized.includes('/smplh/')) {
    return 'smplh';
  }
  if (normalized.includes('/smpl/')) {
    return 'smpl';
  }
  return null;
}

function isSmplWebuserModelPklPath(path: string): boolean {
  const baseName = (getBaseName(path) || path).toLowerCase();
  return (
    baseName.endsWith('.pkl') &&
    baseName.startsWith('basicmodel_') &&
    baseName.includes('_lbs_')
  );
}

function inferJointParentIndices(kintreeRaw: Int32Array, jointCount: number): Int32Array {
  const parentIndices = new Int32Array(jointCount);
  parentIndices.fill(-1);

  if (kintreeRaw.length < jointCount * 2) {
    throw new Error('SMPL kintree_table shape is invalid.');
  }

  for (let column = 0; column < jointCount; column += 1) {
    const parentRaw = kintreeRaw[column] ?? -1;
    const childId = kintreeRaw[jointCount + column] ?? column;
    if (childId < 0 || childId >= jointCount) {
      continue;
    }

    if (parentRaw < 0 || parentRaw >= jointCount || parentRaw === childId) {
      parentIndices[childId] = -1;
      continue;
    }

    parentIndices[childId] = parentRaw;
  }

  if (parentIndices[0] !== -1) {
    parentIndices[0] = -1;
  }

  return parentIndices;
}

function buildTop4SkinningWeights(
  denseWeights: Float32Array,
  vertexCount: number,
  jointCount: number,
): {
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
} {
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    let bestIndex0 = 0;
    let bestWeight0 = 0;
    let bestIndex1 = 0;
    let bestWeight1 = 0;
    let bestIndex2 = 0;
    let bestWeight2 = 0;
    let bestIndex3 = 0;
    let bestWeight3 = 0;

    const rowBase = vertexIndex * jointCount;
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      const weight = denseWeights[rowBase + jointIndex] ?? 0;
      if (weight <= bestWeight3) {
        continue;
      }

      if (weight > bestWeight0) {
        bestWeight3 = bestWeight2;
        bestIndex3 = bestIndex2;
        bestWeight2 = bestWeight1;
        bestIndex2 = bestIndex1;
        bestWeight1 = bestWeight0;
        bestIndex1 = bestIndex0;
        bestWeight0 = weight;
        bestIndex0 = jointIndex;
        continue;
      }

      if (weight > bestWeight1) {
        bestWeight3 = bestWeight2;
        bestIndex3 = bestIndex2;
        bestWeight2 = bestWeight1;
        bestIndex2 = bestIndex1;
        bestWeight1 = weight;
        bestIndex1 = jointIndex;
        continue;
      }

      if (weight > bestWeight2) {
        bestWeight3 = bestWeight2;
        bestIndex3 = bestIndex2;
        bestWeight2 = weight;
        bestIndex2 = jointIndex;
        continue;
      }

      bestWeight3 = weight;
      bestIndex3 = jointIndex;
    }

    const sum = bestWeight0 + bestWeight1 + bestWeight2 + bestWeight3;
    const base = vertexIndex * 4;

    skinIndices[base] = bestIndex0;
    skinIndices[base + 1] = bestIndex1;
    skinIndices[base + 2] = bestIndex2;
    skinIndices[base + 3] = bestIndex3;

    if (sum > 1e-8) {
      const inv = 1 / sum;
      skinWeights[base] = bestWeight0 * inv;
      skinWeights[base + 1] = bestWeight1 * inv;
      skinWeights[base + 2] = bestWeight2 * inv;
      skinWeights[base + 3] = bestWeight3 * inv;
    } else {
      skinWeights[base] = 1;
      skinWeights[base + 1] = 0;
      skinWeights[base + 2] = 0;
      skinWeights[base + 3] = 0;
      skinIndices[base] = 0;
      skinIndices[base + 1] = 0;
      skinIndices[base + 2] = 0;
      skinIndices[base + 3] = 0;
    }
  }

  return {
    skinIndices,
    skinWeights,
  };
}

function computeShapedVertices(
  vTemplate: Float64Array,
  shapedirs: Float64Array,
  vertexCount: number,
  betaCount: number,
  betas: Float64Array,
): Float32Array {
  const output = new Float32Array(vertexCount * 3);

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const baseIndex = vertexIndex * 3 + axis;
      let value = vTemplate[baseIndex] ?? 0;
      const shapedirBase = baseIndex * betaCount;
      for (let betaIndex = 0; betaIndex < betaCount; betaIndex += 1) {
        value += (shapedirs[shapedirBase + betaIndex] ?? 0) * (betas[betaIndex] ?? 0);
      }
      output[baseIndex] = value;
    }
  }

  return output;
}

function computeJointRestPositions(
  regressor: Float64Array,
  shapedVertices: Float32Array,
  jointCount: number,
  vertexCount: number,
): Float32Array {
  const joints = new Float32Array(jointCount * 3);

  for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
    const rowBase = jointIndex * vertexCount;

    let x = 0;
    let y = 0;
    let z = 0;

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      const weight = regressor[rowBase + vertexIndex] ?? 0;
      if (weight === 0) {
        continue;
      }

      const vertexBase = vertexIndex * 3;
      x += weight * (shapedVertices[vertexBase] ?? 0);
      y += weight * (shapedVertices[vertexBase + 1] ?? 0);
      z += weight * (shapedVertices[vertexBase + 2] ?? 0);
    }

    const outBase = jointIndex * 3;
    joints[outBase] = x;
    joints[outBase + 1] = y;
    joints[outBase + 2] = z;
  }

  return joints;
}

function ensureMatrixShape(shape: number[], expectedRank: number, label: string): void {
  if (shape.length !== expectedRank) {
    throw new Error(`${label} has invalid rank. Expected ${expectedRank}, got ${shape.length}.`);
  }
}

function mergeFileMaps(left: DroppedFileMap, right: DroppedFileMap): DroppedFileMap {
  const merged: DroppedFileMap = new Map();
  for (const [key, file] of left) {
    merged.set(key, file);
  }
  for (const [key, file] of right) {
    merged.set(key, file);
  }
  return merged;
}

type SmplModelSelectionReason =
  | 'first'
  | 'gender_match'
  | 'gender_multi_match'
  | 'neutral_fallback'
  | 'no_gender_match';

interface SmplModelSelectionDecision {
  path: string;
  reason: SmplModelSelectionReason;
}

function selectModelPathForMotionGender(
  modelPaths: string[],
  motionGender: SmplGender | null,
): SmplModelSelectionDecision | null {
  const firstPath = modelPaths[0] ?? null;
  if (!firstPath) {
    return null;
  }
  if (!motionGender || motionGender === 'neutral') {
    return {
      path: firstPath,
      reason: 'first',
    };
  }

  const exactMatches = modelPaths.filter((path) => inferModelGenderFromPath(path) === motionGender);
  if (exactMatches.length === 1) {
    return {
      path: exactMatches[0] ?? firstPath,
      reason: 'gender_match',
    };
  }
  if (exactMatches.length > 1) {
    return {
      path: exactMatches[0] ?? firstPath,
      reason: 'gender_multi_match',
    };
  }

  const neutralMatches = modelPaths.filter((path) => inferModelGenderFromPath(path) === 'neutral');
  if (neutralMatches.length > 0) {
    return {
      path: neutralMatches[0] ?? firstPath,
      reason: 'neutral_fallback',
    };
  }

  return {
    path: firstPath,
    reason: 'no_gender_match',
  };
}

export class SmplMotionService {
  async loadModelOnlyFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredModelPath?: string,
  ): Promise<SmplModelLoadResult> {
    const scan = await this.scanDroppedNpzFiles(fileMap);

    let selectedModelPath: string | null = null;
    if (preferredModelPath) {
      const normalized = normalizePath(preferredModelPath);
      selectedModelPath = scan.modelPaths.find((path) => path === normalized) ?? null;
      if (!selectedModelPath) {
        throw new Error(`Requested SMPL model not found: ${preferredModelPath}`);
      }
    } else {
      selectedModelPath = scan.modelPaths[0] ?? null;
    }

    if (!selectedModelPath) {
      throw new Error(
        'No SMPL model found. Supported model files: .npz (v_template/shapedirs/weights/kintree_table/J_regressor/f) or smpl_webuser basicmodel_*.pkl.',
      );
    }

    const modelFile = fileMap.get(selectedModelPath);
    if (!modelFile) {
      throw new Error(`Selected SMPL model file is missing from file map: ${selectedModelPath}`);
    }

    const warnings = new Set<string>();

    const modelName = buildDisplayName(selectedModelPath, 'smpl_model');
    const model = await this.loadModelFromFile(modelFile, selectedModelPath, null, warnings);
    const modelGender = inferModelGenderFromPath(selectedModelPath);
    const rig = this.buildRig(model, modelName);
    rig.sceneObject.userData.rootTrackNode = rig.bones[0] ?? null;

    return {
      selectedModelPath,
      availableModelPaths: scan.modelPaths,
      sceneObject: rig.sceneObject,
      playbackTarget: {
        rootGroup: rig.rootGroup,
        bones: rig.bones,
      },
      modelName,
      modelGender,
      vertexCount: model.vertexCount,
      jointCount: model.jointCount,
      warnings: [...warnings],
    };
  }

  async scanDroppedNpzFiles(fileMap: DroppedFileMap): Promise<SmplNpzScanResult> {
    const pklModelPaths = sortPaths(
      [...fileMap.keys()].filter((path) => isSmplWebuserModelPklPath(path)),
    );
    const npzPaths = sortPaths(
      [...fileMap.keys()].filter((path) => path.toLowerCase().endsWith('.npz')),
    );

    const modelPaths: string[] = [...pklModelPaths];
    const motionPaths: string[] = [];
    const unknownNpzPaths: string[] = [];

    for (const npzPath of npzPaths) {
      const file = fileMap.get(npzPath);
      if (!file) {
        continue;
      }

      const archive = await parseNpzFile(file);
      const names = new Set(archive.listFileNames().map((name) => normalizePath(name)));

      const isModel = REQUIRED_MODEL_ENTRIES.every((entry) => names.has(entry));
      const isMotion = REQUIRED_MOTION_ENTRIES.every((entry) => names.has(entry));

      if (isModel) {
        modelPaths.push(npzPath);
      }
      if (isMotion) {
        motionPaths.push(npzPath);
      }
      if (!isModel && !isMotion) {
        unknownNpzPaths.push(npzPath);
      }
    }

    return {
      modelPaths,
      motionPaths,
      unknownNpzPaths,
    };
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredModelPath?: string,
    preferredMotionPath?: string,
  ): Promise<SmplMotionLoadResult> {
    const scan = await this.scanDroppedNpzFiles(fileMap);
    const warnings = new Set<string>();

    let selectedMotionPath: string | null = null;
    if (preferredMotionPath) {
      const normalized = normalizePath(preferredMotionPath);
      selectedMotionPath = scan.motionPaths.find((path) => path === normalized) ?? null;
      if (!selectedMotionPath) {
        throw new Error(`Requested SMPL motion not found: ${preferredMotionPath}`);
      }
    } else {
      selectedMotionPath = scan.motionPaths[0] ?? null;
    }

    if (!selectedMotionPath && scan.motionPaths.length === 0) {
      throw new Error('No SMPL motion .npz found. Expected keys: poses/trans.');
    }
    if (!selectedMotionPath) {
      throw new Error('Both SMPL model and motion .npz files are required.');
    }
    if (!preferredMotionPath && scan.motionPaths.length > 1) {
      warnings.add(`Multiple SMPL motion files found. Auto-selected ${selectedMotionPath}.`);
    }

    const motionFile = fileMap.get(selectedMotionPath);
    if (!motionFile) {
      throw new Error(`Selected SMPL motion file is missing from file map: ${selectedMotionPath}`);
    }

    const motionArchive = await parseNpzFile(motionFile);
    const sequenceName = await this.resolveMotionSequenceName(
      motionArchive,
      selectedMotionPath,
      warnings,
    );
    const motionGender = await this.resolveMotionGender(motionArchive, warnings);
    if (!motionGender && this.isLikelyOmomoSequence(sequenceName, selectedMotionPath)) {
      warnings.add('SMPL gender.npy missing; gender mismatch check was skipped.');
    }
    const objectName = await this.resolveMotionObjectName(
      motionArchive,
      selectedMotionPath,
      warnings,
      sequenceName,
    );

    let selectedModelPath: string | null = null;
    let modelSelectionDecision: SmplModelSelectionDecision | null = null;
    if (preferredModelPath) {
      const normalized = normalizePath(preferredModelPath);
      selectedModelPath = scan.modelPaths.find((path) => path === normalized) ?? null;
      if (!selectedModelPath) {
        throw new Error(`Requested SMPL model not found: ${preferredModelPath}`);
      }
    } else if (scan.modelPaths.length > 1) {
      modelSelectionDecision = selectModelPathForMotionGender(scan.modelPaths, motionGender);
      selectedModelPath = modelSelectionDecision?.path ?? null;
      if (selectedModelPath && modelSelectionDecision) {
        if (modelSelectionDecision.reason === 'gender_multi_match') {
          warnings.add(
            `Motion gender is ${motionGender}; multiple matching models found, auto-selected ${selectedModelPath}.`,
          );
        } else if (modelSelectionDecision.reason === 'neutral_fallback') {
          warnings.add(
            `Motion gender is ${motionGender}; no exact model match found, auto-selected neutral model ${selectedModelPath}.`,
          );
        } else if (modelSelectionDecision.reason === 'no_gender_match') {
          warnings.add(
            `Motion gender is ${motionGender}; no matching model gender found, auto-selected ${selectedModelPath}.`,
          );
        }
      }
    } else {
      selectedModelPath = scan.modelPaths[0] ?? null;
    }

    if (!selectedModelPath && scan.modelPaths.length === 0) {
      throw new Error('No SMPL model found. Supported model files: .npz or smpl_webuser basicmodel_*.pkl.');
    }
    if (!selectedModelPath) {
      throw new Error('Both SMPL model and motion .npz files are required.');
    }
    const modelFile = fileMap.get(selectedModelPath);
    if (!modelFile) {
      throw new Error(`Selected SMPL model file is missing from file map: ${selectedModelPath}`);
    }

    const clipName = buildDisplayName(selectedMotionPath, 'smpl_motion.npz');
    const modelName = buildDisplayName(selectedModelPath, 'smpl_model');

    const motionPoses = await motionArchive.readNpy('poses.npy');
    const motionTrans = await motionArchive.readNpy('trans.npy');
    const motionBetas = motionArchive.hasFile('betas.npy')
      ? await motionArchive.readNpy('betas.npy')
      : null;
    const motionFps = motionArchive.hasFile('mocap_framerate.npy')
      ? await motionArchive.readNpy('mocap_framerate.npy')
      : motionArchive.hasFile('mocap_frame_rate.npy')
        ? await motionArchive.readNpy('mocap_frame_rate.npy')
        : null;

    ensureMatrixShape(motionPoses.shape, 2, 'SMPL motion poses.npy');
    ensureMatrixShape(motionTrans.shape, 2, 'SMPL motion trans.npy');
    const poseValues = motionPoses.toNumberArray();
    const transValues = motionTrans.toNumberArray();

    const poseFrameCount = motionPoses.shape[0] ?? 0;
    const poseStride = motionPoses.shape[1] ?? 0;
    const transFrameCount = motionTrans.shape[0] ?? 0;
    const transStride = motionTrans.shape[1] ?? 0;

    if (poseFrameCount <= 0 || poseStride <= 0) {
      throw new Error('SMPL poses.npy has no valid motion frames.');
    }
    if (transFrameCount <= 0 || transStride < 3) {
      throw new Error('SMPL trans.npy must contain at least 3 columns per frame.');
    }

    if (transStride > 3) {
      warnings.add(`SMPL trans.npy has ${transStride} columns; only XYZ are used.`);
    }

    const frameCount = Math.min(poseFrameCount, transFrameCount);
    if (frameCount <= 0) {
      throw new Error('SMPL motion has no overlapping frames between poses and trans.');
    }
    if (poseFrameCount !== transFrameCount) {
      warnings.add(
        `SMPL poses/trans frame count mismatch (${poseFrameCount} vs ${transFrameCount}); truncated to ${frameCount}.`,
      );
    }

    const model = await this.loadModelFromFile(modelFile, selectedModelPath, motionBetas, warnings);
    const rig = this.buildRig(model, modelName);
    const modelGender = inferModelGenderFromPath(selectedModelPath);
    const modelFamily = inferModelFamilyFromPath(selectedModelPath);
    const hasStrictGenderMismatch =
      Boolean(motionGender) &&
      Boolean(modelGender) &&
      motionGender !== 'neutral' &&
      modelGender !== 'neutral' &&
      motionGender !== modelGender;
    if (hasStrictGenderMismatch) {
      throw new Error(
        `SMPL gender mismatch: motion is ${motionGender}, model is ${modelGender}. Load a matching ${motionGender} model.`,
      );
    }
    if (!modelGender) {
      const motionGenderLabel = motionGender ?? 'unknown';
      warnings.add(
        `Current model gender: unknown (motion: ${motionGenderLabel}). If motion looks incorrect, verify model and motion gender match.`,
      );
    }
    if (
      this.isLikelyOmomoSequence(sequenceName, selectedMotionPath) &&
      modelFamily &&
      modelFamily !== 'smplx'
    ) {
      warnings.add(
        `OMOMO reference videos use SMPL-X. Current model appears to be ${modelFamily.toUpperCase()}, so body shape/pose details may differ.`,
      );
    }

    const jointCountFromPose = Math.floor(poseStride / 3);
    const usableJointCount = Math.min(model.jointCount, jointCountFromPose);
    if (jointCountFromPose < model.jointCount) {
      warnings.add(
        `SMPL motion has ${jointCountFromPose} joints, model has ${model.jointCount}; only first ${usableJointCount} joints are animated.`,
      );
    } else if (jointCountFromPose > model.jointCount) {
      warnings.add(
        `SMPL motion has ${jointCountFromPose} joints, model has ${model.jointCount}; extra joints are ignored.`,
      );
    }

    const poses = new Float32Array(frameCount * poseStride);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const srcBase = frameIndex * poseStride;
      const dstBase = frameIndex * poseStride;
      for (let elementIndex = 0; elementIndex < poseStride; elementIndex += 1) {
        poses[dstBase + elementIndex] = poseValues[srcBase + elementIndex] ?? 0;
      }
    }

    const trans = new Float32Array(frameCount * 3);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const srcBase = frameIndex * transStride;
      const dstBase = frameIndex * 3;
      trans[dstBase] = transValues[srcBase] ?? 0;
      trans[dstBase + 1] = transValues[srcBase + 1] ?? 0;
      trans[dstBase + 2] = transValues[srcBase + 2] ?? 0;
    }

    let objectMotion: SmplObjectMotionTrack | null = null;
    if (motionArchive.hasFile('obj_trans.npy')) {
      const objTransRaw = await motionArchive.readNpy('obj_trans.npy');
      const objTransShape = objTransRaw.shape;
      const objTransValues = objTransRaw.toNumberArray();

      let objTransFrameCount = 0;
      let objTransStride = 0;
      if (objTransShape.length === 2) {
        objTransFrameCount = objTransShape[0] ?? 0;
        objTransStride = objTransShape[1] ?? 0;
      } else if (objTransShape.length === 3) {
        const axisCount = objTransShape[1] ?? 0;
        const tailCount = objTransShape[2] ?? 0;
        if (axisCount !== 3 || tailCount !== 1) {
          throw new Error(
            `SMPL motion obj_trans.npy shape must be [T,3] or [T,3,1], got [${objTransShape.join(', ')}].`,
          );
        }
        objTransFrameCount = objTransShape[0] ?? 0;
        objTransStride = 3;
      } else {
        throw new Error(
          `SMPL motion obj_trans.npy rank must be 2 or 3, got ${objTransShape.length}.`,
        );
      }

      if (objTransFrameCount <= 0 || objTransStride < 3) {
        throw new Error('SMPL motion obj_trans.npy must contain at least XYZ columns per frame.');
      }
      if (objTransStride > 3) {
        warnings.add(`SMPL obj_trans.npy has ${objTransStride} columns; only XYZ are used.`);
      }

      let objectFrameCount = Math.min(frameCount, objTransFrameCount);
      let rotMatValues: Float32Array | null = null;
      let scaleValues: Float32Array | null = null;

      if (motionArchive.hasFile('obj_rot_mat.npy')) {
        const objRotRaw = await motionArchive.readNpy('obj_rot_mat.npy');
        const objRotShape = objRotRaw.shape;
        const objRotValues = objRotRaw.toNumberArray();

        let objRotFrameCount = 0;
        let objRotStride = 0;
        if (objRotShape.length === 3) {
          const rowCount = objRotShape[1] ?? 0;
          const columnCount = objRotShape[2] ?? 0;
          if (rowCount !== 3 || columnCount !== 3) {
            throw new Error(
              `SMPL motion obj_rot_mat.npy shape must be [T,3,3], got [${objRotShape.join(', ')}].`,
            );
          }
          objRotFrameCount = objRotShape[0] ?? 0;
          objRotStride = 9;
        } else if (objRotShape.length === 2) {
          objRotFrameCount = objRotShape[0] ?? 0;
          objRotStride = objRotShape[1] ?? 0;
          if (objRotStride < 9) {
            throw new Error(
              `SMPL motion obj_rot_mat.npy must have at least 9 columns, got ${objRotStride}.`,
            );
          }
        } else {
          throw new Error(
            `SMPL motion obj_rot_mat.npy rank must be 2 or 3, got ${objRotShape.length}.`,
          );
        }

        if (objRotStride > 9) {
          warnings.add(`SMPL obj_rot_mat.npy has ${objRotStride} columns; only first 9 are used.`);
        }
        objectFrameCount = Math.min(objectFrameCount, objRotFrameCount);

        rotMatValues = new Float32Array(objectFrameCount * 9);
        for (let frameIndex = 0; frameIndex < objectFrameCount; frameIndex += 1) {
          const srcBase = frameIndex * objRotStride;
          const dstBase = frameIndex * 9;
          for (let idx = 0; idx < 9; idx += 1) {
            rotMatValues[dstBase + idx] = objRotValues[srcBase + idx] ?? 0;
          }
        }
      }

      if (motionArchive.hasFile('obj_scale.npy')) {
        const objScaleRaw = await motionArchive.readNpy('obj_scale.npy');
        const objScaleShape = objScaleRaw.shape;
        const objScaleRawValues = objScaleRaw.toNumberArray();

        let objScaleFrameCount = 0;
        let objScaleStride = 1;
        if (objScaleShape.length === 1) {
          objScaleFrameCount = objScaleShape[0] ?? 0;
        } else if (objScaleShape.length === 2) {
          objScaleFrameCount = objScaleShape[0] ?? 0;
          objScaleStride = objScaleShape[1] ?? 0;
          if (objScaleStride <= 0) {
            throw new Error('SMPL motion obj_scale.npy has invalid second dimension.');
          }
          if (objScaleStride > 1) {
            warnings.add(`SMPL obj_scale.npy has ${objScaleStride} columns; only first value is used.`);
          }
        } else {
          throw new Error(
            `SMPL motion obj_scale.npy rank must be 1 or 2, got ${objScaleShape.length}.`,
          );
        }

        objectFrameCount = Math.min(objectFrameCount, objScaleFrameCount);
        scaleValues = new Float32Array(objectFrameCount);
        for (let frameIndex = 0; frameIndex < objectFrameCount; frameIndex += 1) {
          const srcIndex = frameIndex * objScaleStride;
          scaleValues[frameIndex] = objScaleRawValues[srcIndex] ?? 1;
        }
      }

      if (objectFrameCount > 0) {
        const objectTrans = new Float32Array(objectFrameCount * 3);
        for (let frameIndex = 0; frameIndex < objectFrameCount; frameIndex += 1) {
          const srcBase = frameIndex * objTransStride;
          const dstBase = frameIndex * 3;
          objectTrans[dstBase] = objTransValues[srcBase] ?? 0;
          objectTrans[dstBase + 1] = objTransValues[srcBase + 1] ?? 0;
          objectTrans[dstBase + 2] = objTransValues[srcBase + 2] ?? 0;
        }

        if (objectFrameCount < frameCount) {
          warnings.add(
            `SMPL object tracks have ${objectFrameCount} frames; playback has ${frameCount}. Object uses last valid frame when needed.`,
          );
        }

        objectMotion = {
          frameCount: objectFrameCount,
          trans: objectTrans,
          rotMat: rotMatValues,
          scale: scaleValues,
        };
      }
    }

    if (
      motionArchive.hasFile('obj_bottom_trans.npy') ||
      motionArchive.hasFile('obj_bottom_rot_mat.npy') ||
      motionArchive.hasFile('obj_bottom_scale.npy')
    ) {
      warnings.add(
        'SMPL motion contains obj_bottom_* tracks; current web playback applies only the primary object track.',
      );
    }

    const rootJointRestOffset: [number, number, number] = [
      model.jointRestPositions[0] ?? 0,
      model.jointRestPositions[1] ?? 0,
      model.jointRestPositions[2] ?? 0,
    ];
    let transToJointOffset = await this.resolveMotionTransToJointOffset(motionArchive, warnings);
    if (!transToJointOffset && objectMotion && this.isLikelyOmomoSequence(sequenceName, selectedMotionPath)) {
      transToJointOffset = this.getOmomoFallbackTransToJointOffset(motionGender);
      const fallbackLabel = motionGender && motionGender !== 'neutral' ? motionGender : 'global';
      warnings.add(
        `SMPL trans2joint.npy missing; applied OMOMO ${fallbackLabel} fallback trans2joint for object alignment.`,
      );
    }
    const objectAlignmentOffset: [number, number, number] | null =
      objectMotion && transToJointOffset
        ? [
            rootJointRestOffset[0] + transToJointOffset[0],
            rootJointRestOffset[1] + transToJointOffset[1],
            rootJointRestOffset[2] + transToJointOffset[2],
          ]
        : null;

    const fps = motionFps ? Math.max(1, motionFps.toScalarNumber()) : 30;
    const translationOffsetXY: [number, number] = [trans[0] ?? 0, trans[1] ?? 0];

    const clip: SmplMotionClip = {
      name: clipName,
      sourcePath: selectedMotionPath,
      frameCount,
      fps,
      jointCount: usableJointCount,
      poseStride,
      poses,
      trans,
      translationOffsetXY,
      objectMotion,
      objectAlignmentOffset,
      objectName,
    };

    rig.sceneObject.userData.rootTrackNode = rig.bones[0] ?? null;

    return {
      selectedModelPath,
      selectedMotionPath,
      availableModelPaths: scan.modelPaths,
      sceneObject: rig.sceneObject,
      playbackTarget: {
        rootGroup: rig.rootGroup,
        bones: rig.bones,
      },
      clip,
      modelName,
      motionName: clipName,
      objectName,
      frameCount,
      fps,
      vertexCount: model.vertexCount,
      jointCount: usableJointCount,
      motionGender,
      modelGender,
      hasObjectMotion: Boolean(objectMotion),
      warnings: [...warnings],
    };
  }

  mergeDroppedFileMaps(...maps: DroppedFileMap[]): DroppedFileMap {
    let merged: DroppedFileMap = new Map();
    for (const map of maps) {
      merged = mergeFileMaps(merged, map);
    }
    return merged;
  }

  private async resolveMotionObjectName(
    motionArchive: Awaited<ReturnType<typeof parseNpzFile>>,
    selectedMotionPath: string,
    warnings: Set<string>,
    sequenceNameHint: string | null = null,
  ): Promise<string | null> {
    const motionObjectName = await this.readScalarStringEntry(motionArchive, 'obj_name.npy', warnings);
    if (motionObjectName) {
      const normalized = normalizeObjectNameToken(motionObjectName);
      if (normalized) {
        return normalized;
      }
    }

    const sequenceName =
      sequenceNameHint ?? (await this.readScalarStringEntry(motionArchive, 'seq_name.npy', warnings));
    if (sequenceName) {
      const inferredFromSeq = inferObjectNameFromSeqLikeName(sequenceName);
      if (inferredFromSeq) {
        return inferredFromSeq;
      }
    }

    const sourceStem = (getBaseName(selectedMotionPath) || selectedMotionPath).replace(
      /\.[^/.]+$/,
      '',
    );
    return inferObjectNameFromSeqLikeName(sourceStem);
  }

  private async readScalarStringEntry(
    motionArchive: Awaited<ReturnType<typeof parseNpzFile>>,
    entryName: string,
    warnings: Set<string>,
  ): Promise<string | null> {
    if (!motionArchive.hasFile(entryName)) {
      return null;
    }

    try {
      const scalar = await motionArchive.readNpy(entryName);
      const value = scalar.toScalarString().trim();
      return value || null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.add(`SMPL ${entryName} could not be parsed as scalar string (${reason}).`);
      return null;
    }
  }

  private async resolveMotionSequenceName(
    motionArchive: Awaited<ReturnType<typeof parseNpzFile>>,
    selectedMotionPath: string,
    warnings: Set<string>,
  ): Promise<string | null> {
    const sequenceName = await this.readScalarStringEntry(motionArchive, 'seq_name.npy', warnings);
    if (sequenceName) {
      return sequenceName;
    }

    const sourceStem = (getBaseName(selectedMotionPath) || selectedMotionPath).replace(
      /\.[^/.]+$/,
      '',
    );
    return sourceStem || null;
  }

  private async resolveMotionGender(
    motionArchive: Awaited<ReturnType<typeof parseNpzFile>>,
    warnings: Set<string>,
  ): Promise<SmplGender | null> {
    const genderRaw = await this.readScalarStringEntry(motionArchive, 'gender.npy', warnings);
    if (!genderRaw) {
      return null;
    }

    const normalized = normalizeGenderToken(genderRaw);
    if (!normalized) {
      warnings.add(`SMPL gender.npy value "${genderRaw}" is not recognized; gender mismatch check skipped.`);
      return null;
    }
    return normalized;
  }

  private isLikelyOmomoSequence(sequenceName: string | null, selectedMotionPath: string): boolean {
    if (sequenceName && OMOMO_SEQUENCE_NAME_PATTERN.test(sequenceName)) {
      return true;
    }

    const sourceStem = (getBaseName(selectedMotionPath) || selectedMotionPath).replace(
      /\.[^/.]+$/,
      '',
    );
    if (OMOMO_SEQUENCE_NAME_PATTERN.test(sourceStem)) {
      return true;
    }

    const normalizedPath = normalizePath(selectedMotionPath);
    return normalizedPath.includes('/omomo/');
  }

  private async resolveMotionTransToJointOffset(
    motionArchive: Awaited<ReturnType<typeof parseNpzFile>>,
    warnings: Set<string>,
  ): Promise<[number, number, number] | null> {
    if (!motionArchive.hasFile('trans2joint.npy')) {
      return null;
    }

    try {
      const raw = await motionArchive.readNpy('trans2joint.npy');
      const shape = raw.shape;
      const values = raw.toNumberArray();

      if (shape.length === 1 && (shape[0] ?? 0) >= 3) {
        return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      }
      if (shape.length === 2 && (shape[0] ?? 0) === 1 && (shape[1] ?? 0) >= 3) {
        return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      }
      if (shape.length === 2 && (shape[1] ?? 0) === 1 && (shape[0] ?? 0) >= 3) {
        return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      }

      warnings.add(
        `SMPL trans2joint.npy has unsupported shape [${shape.join(', ')}]; object alignment fallback may be used.`,
      );
      return null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.add(`SMPL trans2joint.npy could not be parsed (${reason}).`);
      return null;
    }
  }

  private getOmomoFallbackTransToJointOffset(
    motionGender: SmplGender | null,
  ): [number, number, number] {
    if (motionGender === 'male') {
      return [...OMOMO_TRANS_TO_JOINT_FALLBACK_BY_GENDER.male];
    }
    if (motionGender === 'female') {
      return [...OMOMO_TRANS_TO_JOINT_FALLBACK_BY_GENDER.female];
    }
    return [...OMOMO_TRANS_TO_JOINT_FALLBACK_ALL];
  }

  private async loadModelFromFile(
    modelFile: File,
    modelPath: string,
    motionBetas: ParsedNpyArray | null,
    warnings: Set<string>,
  ): Promise<SmplModelData> {
    if (isSmplWebuserModelPklPath(modelPath)) {
      const payload = await parseSmplWebuserPkl(modelFile);
      return this.loadModelFromPklPayload(payload, motionBetas, warnings);
    }

    const archive = await parseNpzFile(modelFile);
    return this.loadModelFromNpzArchive(archive, motionBetas, warnings);
  }

  private async loadModelFromNpzArchive(
    modelArchive: Awaited<ReturnType<typeof parseNpzFile>>,
    motionBetas: ParsedNpyArray | null,
    warnings: Set<string>,
  ): Promise<SmplModelData> {
    const modelVTemplate = await modelArchive.readNpy('v_template.npy');
    const modelShapedirs = await modelArchive.readNpy('shapedirs.npy');
    const modelWeights = await modelArchive.readNpy('weights.npy');
    const modelKintree = await modelArchive.readNpy('kintree_table.npy');
    const modelJRegressor = await modelArchive.readNpy('J_regressor.npy');
    const modelFaces = await modelArchive.readNpy('f.npy');

    ensureMatrixShape(modelVTemplate.shape, 2, 'SMPL model v_template.npy');
    ensureMatrixShape(modelShapedirs.shape, 3, 'SMPL model shapedirs.npy');
    ensureMatrixShape(modelWeights.shape, 2, 'SMPL model weights.npy');
    ensureMatrixShape(modelKintree.shape, 2, 'SMPL model kintree_table.npy');
    ensureMatrixShape(modelJRegressor.shape, 2, 'SMPL model J_regressor.npy');
    ensureMatrixShape(modelFaces.shape, 2, 'SMPL model f.npy');

    const raw: SmplModelRawPayload = {
      vTemplateShape: [...modelVTemplate.shape],
      vTemplateValues: modelVTemplate.toNumberArray(),
      shapedirsShape: [...modelShapedirs.shape],
      shapedirsValues: modelShapedirs.toNumberArray(),
      weightsShape: [...modelWeights.shape],
      weightsValues: modelWeights.toNumberArray(),
      kintreeShape: [...modelKintree.shape],
      kintreeValues: modelKintree.toIntArray(),
      regressorShape: [...modelJRegressor.shape],
      regressorValues: modelJRegressor.toNumberArray(),
      facesShape: [...modelFaces.shape],
      facesValues: modelFaces.toUintArray(),
    };

    return this.buildModelDataFromRaw(raw, motionBetas, warnings, 'SMPL model npz');
  }

  private loadModelFromPklPayload(
    payload: ParsedSmplWebuserPkl,
    motionBetas: ParsedNpyArray | null,
    warnings: Set<string>,
  ): SmplModelData {
    const raw: SmplModelRawPayload = {
      vTemplateShape: [...payload.vTemplate.shape],
      vTemplateValues: payload.vTemplate.values,
      shapedirsShape: [...payload.shapedirs.shape],
      shapedirsValues: payload.shapedirs.values,
      weightsShape: [...payload.weights.shape],
      weightsValues: payload.weights.values,
      kintreeShape: [...payload.kintreeTable.shape],
      kintreeValues: payload.kintreeTable.values,
      regressorShape: [...payload.jRegressor.shape],
      regressorValues: payload.jRegressor.values,
      facesShape: [...payload.faces.shape],
      facesValues: payload.faces.values,
    };

    return this.buildModelDataFromRaw(raw, motionBetas, warnings, 'SMPL model pkl');
  }

  private buildModelDataFromRaw(
    raw: SmplModelRawPayload,
    motionBetas: ParsedNpyArray | null,
    warnings: Set<string>,
    sourceLabel: string,
  ): SmplModelData {
    const vertexCount = raw.vTemplateShape[0] ?? 0;
    const vTemplateStride = raw.vTemplateShape[1] ?? 0;
    if (vertexCount <= 0 || vTemplateStride !== 3) {
      throw new Error(`${sourceLabel}: v_template must have shape [N, 3].`);
    }

    const shapedirVertexCount = raw.shapedirsShape[0] ?? 0;
    const shapedirAxisCount = raw.shapedirsShape[1] ?? 0;
    const shapeBetaCount = raw.shapedirsShape[2] ?? 0;
    if (shapedirVertexCount !== vertexCount || shapedirAxisCount !== 3 || shapeBetaCount <= 0) {
      throw new Error(`${sourceLabel}: shapedirs must have shape [N, 3, B] aligned with v_template.`);
    }

    const weightVertexCount = raw.weightsShape[0] ?? 0;
    const jointCount = raw.weightsShape[1] ?? 0;
    if (weightVertexCount !== vertexCount || jointCount <= 0) {
      throw new Error(`${sourceLabel}: weights must have shape [N, J] aligned with v_template.`);
    }

    const regressorJointCount = raw.regressorShape[0] ?? 0;
    const regressorVertexCount = raw.regressorShape[1] ?? 0;
    if (regressorJointCount !== jointCount || regressorVertexCount !== vertexCount) {
      throw new Error(`${sourceLabel}: J_regressor shape must be [J, N] and match weights/v_template.`);
    }

    const kintreeRows = raw.kintreeShape[0] ?? 0;
    const kintreeColumns = raw.kintreeShape[1] ?? 0;
    if (kintreeRows !== 2 || kintreeColumns < jointCount) {
      throw new Error(`${sourceLabel}: kintree_table must have shape [2, J].`);
    }

    const faceCount = raw.facesShape[0] ?? 0;
    const faceStride = raw.facesShape[1] ?? 0;
    if (faceCount <= 0 || faceStride !== 3) {
      throw new Error(`${sourceLabel}: f must have shape [F, 3].`);
    }

    const motionBetasValues = motionBetas ? motionBetas.toNumberArray() : new Float64Array();
    const availableBetas = Math.min(shapeBetaCount, motionBetasValues.length);
    if (motionBetas && motionBetasValues.length < shapeBetaCount) {
      warnings.add(
        `SMPL motion betas has ${motionBetasValues.length} values; model supports ${shapeBetaCount}. Remaining betas use 0.`,
      );
    }

    const betas = new Float64Array(shapeBetaCount);
    for (let index = 0; index < availableBetas; index += 1) {
      betas[index] = motionBetasValues[index] ?? 0;
    }

    const shapedVertices = computeShapedVertices(
      raw.vTemplateValues,
      raw.shapedirsValues,
      vertexCount,
      shapeBetaCount,
      betas,
    );

    const jointRestPositions = computeJointRestPositions(
      raw.regressorValues,
      shapedVertices,
      jointCount,
      vertexCount,
    );

    const parentIndices = inferJointParentIndices(raw.kintreeValues, jointCount);

    const denseWeights = new Float32Array(raw.weightsValues.length);
    for (let index = 0; index < raw.weightsValues.length; index += 1) {
      denseWeights[index] = raw.weightsValues[index] ?? 0;
    }

    return {
      vertexCount,
      jointCount,
      parentIndices,
      jointRestPositions,
      shapedVertices,
      faces: raw.facesValues,
      weights: denseWeights,
      availableBetas,
    };
  }

  private buildRig(model: SmplModelData, modelName: string): SmplRigData {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(model.shapedVertices, 3));
    geometry.setIndex(Array.from(model.faces));

    const top4 = buildTop4SkinningWeights(model.weights, model.vertexCount, model.jointCount);
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(top4.skinIndices, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(top4.skinWeights, 4));
    geometry.computeVertexNormals();

    const material = new MeshStandardMaterial({
      color: new Color('#e2c1a9'),
      roughness: 0.86,
      metalness: 0.0,
      envMapIntensity: 0.2,
      side: DoubleSide,
      skinning: true,
    });

    const skinnedMesh = new SkinnedMesh(geometry, material);
    skinnedMesh.name = `${modelName}-mesh`;
    skinnedMesh.castShadow = true;
    skinnedMesh.receiveShadow = true;
    skinnedMesh.userData.skipMaterialEnhance = true;
    skinnedMesh.userData.castShadow = true;
    skinnedMesh.userData.receiveShadow = true;

    const bones: any[] = [];
    for (let jointIndex = 0; jointIndex < model.jointCount; jointIndex += 1) {
      const bone = new Bone();
      bone.name = `smpl_joint_${jointIndex}`;
      bones.push(bone);
    }

    const rootBones: any[] = [];
    for (let jointIndex = 0; jointIndex < model.jointCount; jointIndex += 1) {
      const parentIndex = model.parentIndices[jointIndex] ?? -1;
      const bone = bones[jointIndex];
      const restBase = jointIndex * 3;

      if (parentIndex < 0) {
        bone.position.set(
          model.jointRestPositions[restBase] ?? 0,
          model.jointRestPositions[restBase + 1] ?? 0,
          model.jointRestPositions[restBase + 2] ?? 0,
        );
        rootBones.push(bone);
      } else {
        const parentBase = parentIndex * 3;
        bone.position.set(
          (model.jointRestPositions[restBase] ?? 0) - (model.jointRestPositions[parentBase] ?? 0),
          (model.jointRestPositions[restBase + 1] ?? 0) -
            (model.jointRestPositions[parentBase + 1] ?? 0),
          (model.jointRestPositions[restBase + 2] ?? 0) -
            (model.jointRestPositions[parentBase + 2] ?? 0),
        );

        const parentBone = bones[parentIndex];
        parentBone?.add(bone);
      }
    }

    for (const rootBone of rootBones) {
      skinnedMesh.add(rootBone);
    }

    const rootGroup = new Group();
    rootGroup.name = `${modelName}-motion-root`;
    rootGroup.add(skinnedMesh);

    const skeleton = new Skeleton(bones);
    skinnedMesh.bind(skeleton);

    const skeletonHelper = new SkeletonHelper(rootGroup);
    skeletonHelper.name = `${modelName}-skeleton`;
    skeletonHelper.visible = false;
    // Keep helper matrix in model-local space to avoid double transforms under rotated scene roots.
    skeletonHelper.matrix = rootGroup.matrix;
    skeletonHelper.matrixAutoUpdate = false;
    const helperMaterial = skeletonHelper.material as any;
    helperMaterial.vertexColors = false;
    helperMaterial.color?.set?.(SKELETON_HIGHLIGHT_COLOR);
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.98;
    helperMaterial.needsUpdate = true;

    const sceneObject = new Group();
    sceneObject.name = modelName;
    sceneObject.userData.smplSkinnedMesh = skinnedMesh;
    sceneObject.userData.smplSkeletonHelper = skeletonHelper;
    sceneObject.add(rootGroup);
    sceneObject.add(skeletonHelper);

    return {
      sceneObject,
      rootGroup,
      skinnedMesh,
      skeletonHelper,
      bones,
    };
  }
}
