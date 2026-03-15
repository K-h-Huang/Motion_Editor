import { Group, SkeletonHelper } from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

import type { DroppedFileMap } from '../../types/viewer';
import { getBaseName, getPathDepth, normalizePath } from '../urdf/pathResolver';

export const BVH_LINEAR_UNITS = ['m', 'dm', 'cm', 'inch', 'feet'] as const;
export type BvhLinearUnit = (typeof BVH_LINEAR_UNITS)[number];

export interface BvhMotionLoadResult {
  clip: any;
  selectedBvhPath: string;
  sceneObject: any;
  playbackTarget: any;
  frameCount: number;
  fps: number;
  jointCount: number;
  linearUnit: BvhLinearUnit;
  unitScale: number;
  warnings: string[];
}

const BVH_UNIT_SCALE: Record<BvhLinearUnit, number> = {
  m: 1,
  dm: 0.1,
  cm: 0.01,
  inch: 0.0254,
  feet: 0.3048,
};
const SKELETON_HIGHLIGHT_COLOR = '#7ef9ff';

function normalizeLinearUnit(linearUnit: BvhLinearUnit): BvhLinearUnit {
  if (BVH_LINEAR_UNITS.includes(linearUnit)) {
    return linearUnit;
  }
  return 'm';
}

interface ParsedTiming {
  frameCount: number;
  fps: number;
}

function sortBvhPaths(paths: string[]): string[] {
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

function parseTrackName(trackName: string): {
  boneName: string;
  propertyName: string;
} | null {
  const dotIndex = trackName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex >= trackName.length - 1) {
    return null;
  }

  const boneName = trackName.slice(0, dotIndex).trim();
  const propertyName = trackName.slice(dotIndex + 1).trim().toLowerCase();
  if (!boneName || !propertyName) {
    return null;
  }

  return {
    boneName,
    propertyName,
  };
}

function inferClipTiming(clip: any): ParsedTiming {
  let sampleTimes: ArrayLike<number> | null = null;

  for (const track of clip.tracks) {
    if (!track.times || track.times.length === 0) {
      continue;
    }

    if (!sampleTimes || track.times.length > sampleTimes.length) {
      sampleTimes = track.times;
    }
  }

  if (sampleTimes && sampleTimes.length > 1) {
    const rawFrameDuration = sampleTimes[1] - sampleTimes[0];
    const safeFrameDuration = Number.isFinite(rawFrameDuration) && rawFrameDuration > 1e-6
      ? rawFrameDuration
      : 1 / 30;
    const fps = 1 / safeFrameDuration;
    return {
      frameCount: sampleTimes.length,
      fps,
    };
  }

  const fallbackFps = 30;
  if (Number.isFinite(clip.duration) && clip.duration > 0) {
    return {
      frameCount: Math.max(1, Math.round(clip.duration * fallbackFps) + 1),
      fps: fallbackFps,
    };
  }

  return {
    frameCount: 1,
    fps: fallbackFps,
  };
}

function countAnimatedJoints(clip: any): number {
  const joints = new Set<string>();
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name);
    if (!parsed || parsed.propertyName !== 'quaternion') {
      continue;
    }

    if (parsed.boneName.toUpperCase() === 'ENDSITE') {
      continue;
    }

    joints.add(parsed.boneName);
  }
  return joints.size;
}

function buildClipName(path: string): string {
  const baseName = getBaseName(path);
  return baseName || 'motion.bvh';
}

function recenterRootTrackXZ(clip: any, rootBoneName: string): void {
  const rootTrackName = `${rootBoneName}.position`;
  const rootTrack = clip.tracks.find((track: any) => track?.name === rootTrackName);
  if (!rootTrack || !rootTrack.values || rootTrack.values.length < 3) {
    return;
  }

  const offsetX = Number(rootTrack.values[0]);
  const offsetZ = Number(rootTrack.values[2]);
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetZ)) {
    return;
  }

  if (Math.abs(offsetX) < 1e-6 && Math.abs(offsetZ) < 1e-6) {
    return;
  }

  for (let index = 0; index < rootTrack.values.length; index += 3) {
    rootTrack.values[index] -= offsetX;
    rootTrack.values[index + 2] -= offsetZ;
  }
}

export class BvhMotionService {
  private readonly loader = new BVHLoader();

  getAvailableBvhPaths(fileMap: DroppedFileMap): string[] {
    return sortBvhPaths(
      [...fileMap.keys()].filter((path) => path.toLowerCase().endsWith('.bvh')),
    );
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredBvhPath?: string,
    linearUnit: BvhLinearUnit = 'm',
  ): Promise<BvhMotionLoadResult> {
    const safeLinearUnit = normalizeLinearUnit(linearUnit);
    const unitScale = BVH_UNIT_SCALE[safeLinearUnit];
    const bvhPaths = this.getAvailableBvhPaths(fileMap);
    let selectedBvhPath: string | null = null;

    if (preferredBvhPath) {
      const normalizedPreferredPath = normalizePath(preferredBvhPath);
      selectedBvhPath =
        bvhPaths.find((path) => path === normalizedPreferredPath) ?? null;
      if (!selectedBvhPath) {
        throw new Error(`Requested BVH not found in dropped files: ${preferredBvhPath}`);
      }
    } else {
      selectedBvhPath = bvhPaths.length > 0 ? bvhPaths[0] : null;
    }

    if (!selectedBvhPath) {
      throw new Error('No BVH file found. Drop a .bvh motion file.');
    }

    const selectedFile = fileMap.get(selectedBvhPath);
    if (!selectedFile) {
      throw new Error(`Selected BVH file is missing from file map: ${selectedBvhPath}`);
    }

    const warnings = new Set<string>();
    if (!preferredBvhPath && bvhPaths.length > 1) {
      warnings.add(
        `Multiple BVH files found. Auto-selected ${selectedBvhPath}. Drop target BVH to choose another.`,
      );
    }

    const bvhText = await selectedFile.text();
    const parsed = this.loader.parse(bvhText);
    const rootBone = parsed.skeleton?.bones?.[0] ?? null;
    if (!rootBone) {
      throw new Error('Failed to parse BVH skeleton root.');
    }

    recenterRootTrackXZ(parsed.clip, rootBone.name);

    const clipName = buildClipName(selectedBvhPath);
    parsed.clip.name = clipName;

    const timing = inferClipTiming(parsed.clip);
    if (timing.frameCount <= 0) {
      throw new Error('BVH does not contain valid animation frames.');
    }

    const helper = new SkeletonHelper(rootBone);
    helper.name = `${clipName}-skeleton`;
    helper.skeleton = parsed.skeleton;
    // Keep helper matrix in model-local space to avoid double transforms under rotated scene roots.
    helper.matrix = rootBone.matrix;
    helper.matrixAutoUpdate = false;
    const helperMaterial = helper.material as any;
    helperMaterial.vertexColors = false;
    helperMaterial.color?.set?.(SKELETON_HIGHLIGHT_COLOR);
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.98;
    helperMaterial.needsUpdate = true;

    const sceneObject = new Group();
    sceneObject.name = `${clipName}-root`;
    sceneObject.scale.setScalar(unitScale);
    sceneObject.userData.bvhLinearUnit = safeLinearUnit;
    sceneObject.userData.bvhUnitScale = unitScale;
    // Expose the animated BVH root for camera root-lock tracking.
    sceneObject.userData.rootTrackNode = rootBone;
    sceneObject.add(rootBone);
    sceneObject.add(helper);

    const jointCount = countAnimatedJoints(parsed.clip);
    if (jointCount === 0) {
      warnings.add('BVH contains no animated joints (quaternion tracks).');
    }

    return {
      clip: parsed.clip,
      selectedBvhPath,
      sceneObject,
      playbackTarget: helper,
      frameCount: timing.frameCount,
      fps: timing.fps,
      jointCount,
      linearUnit: safeLinearUnit,
      unitScale,
      warnings: [...warnings],
    };
  }
}
