import { Box3, Color, DoubleSide, Group, MeshStandardMaterial, Vector3 } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

import type { DroppedFileMap } from '../../types/viewer';
import { getBaseName, getPathDepth, normalizePath } from '../urdf/pathResolver';

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

export interface ObjModelLoadResult {
  selectedObjPath: string;
  sceneObject: any;
  motionRoot: any;
  modelName: string;
  meshCount: number;
  warnings: string[];
}

export interface ObjLoadOptions {
  normalizeToGround?: boolean;
}

const OMOMO_OBJ_COLOR = new Color('#f0a2e8');
const OMOMO_OBJ_EMISSIVE = new Color('#6e4870');

function createOmomoObjMaterial() {
  return new MeshStandardMaterial({
    color: OMOMO_OBJ_COLOR.clone(),
    emissive: OMOMO_OBJ_EMISSIVE.clone().multiplyScalar(0.08),
    roughness: 0.62,
    metalness: 0.02,
    side: DoubleSide,
    vertexColors: false,
  });
}

export class ObjLoadService {
  getAvailableObjPaths(fileMap: DroppedFileMap): string[] {
    return sortPaths([...fileMap.keys()].filter((path) => path.toLowerCase().endsWith('.obj')));
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredObjPath?: string,
    options: ObjLoadOptions = {},
  ): Promise<ObjModelLoadResult> {
    const normalizeToGround = options.normalizeToGround ?? true;
    const objPaths = this.getAvailableObjPaths(fileMap);
    if (objPaths.length === 0) {
      throw new Error('No OBJ model found. Drop one or more .obj files.');
    }

    let selectedObjPath: string | null = null;
    if (preferredObjPath) {
      const normalized = normalizePath(preferredObjPath);
      selectedObjPath = objPaths.find((path) => path === normalized) ?? null;
      if (!selectedObjPath) {
        throw new Error(`Requested OBJ model not found: ${preferredObjPath}`);
      }
    } else {
      selectedObjPath = objPaths[0] ?? null;
    }

    if (!selectedObjPath) {
      throw new Error('Failed to resolve OBJ model path.');
    }

    const file = fileMap.get(selectedObjPath);
    if (!file) {
      throw new Error(`Selected OBJ model file is missing from file map: ${selectedObjPath}`);
    }

    const warnings = new Set<string>();
    if (!preferredObjPath && objPaths.length > 1) {
      warnings.add(`Multiple OBJ files found. Auto-selected ${selectedObjPath}.`);
    }

    const loader = new OBJLoader();
    const source = await file.text();
    const parsed = loader.parse(source);

    let meshCount = 0;
    parsed.traverse((child: unknown) => {
      const maybeMesh = child as any;
      if (!maybeMesh?.isMesh) {
        return;
      }

      meshCount += 1;
      maybeMesh.castShadow = true;
      maybeMesh.receiveShadow = true;
      maybeMesh.userData.skipMaterialEnhance = true;
      maybeMesh.userData.castShadow = true;
      maybeMesh.userData.receiveShadow = true;

      if (maybeMesh.geometry) {
        maybeMesh.geometry.computeVertexNormals();
      }
      maybeMesh.material = createOmomoObjMaterial();
    });

    if (meshCount === 0) {
      throw new Error(`OBJ contains no mesh geometry: ${selectedObjPath}`);
    }

    const rawBounds = new Box3().setFromObject(parsed, true);
    if (rawBounds.isEmpty()) {
      throw new Error(`OBJ bounds are empty: ${selectedObjPath}`);
    }

    if (normalizeToGround) {
      const rawCenter = rawBounds.getCenter(new Vector3());
      parsed.position.x -= rawCenter.x;
      parsed.position.z -= rawCenter.z;
      parsed.position.y -= rawBounds.min.y;
    }

    const modelName = buildDisplayName(selectedObjPath, 'object_model.obj');
    const motionRoot = new Group();
    motionRoot.name = `${modelName}-motion-root`;
    motionRoot.add(parsed);

    const sceneObject = new Group();
    sceneObject.name = modelName;
    sceneObject.userData.objMotionRoot = motionRoot;
    sceneObject.add(motionRoot);

    return {
      selectedObjPath,
      sceneObject,
      motionRoot,
      modelName,
      meshCount,
      warnings: [...warnings],
    };
  }
}
