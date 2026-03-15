import { Group, Mesh, MeshPhongMaterial } from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import URDFLoader from 'urdf-loader';

import {
  DEFAULT_ROOT_COMPONENT_COUNT,
  DEFAULT_ROOT_JOINT_NAME,
} from '../motion/MotionSchema';
import type {
  DroppedFileMap,
  LoadedRobotResult,
  MotionSchema,
  UrdfRobotLike,
} from '../../types/viewer';
import {
  extractRecoverablePathFromBlobUrl,
  getBaseName,
  getDirectoryPath,
  getFileExtension,
  normalizePath,
  selectPrimaryUrdfPath,
  sortUrdfPaths,
  resolveFileKeyForRequest,
} from './pathResolver';

function buildMotionSchema(robot: UrdfRobotLike): MotionSchema {
  const joints = robot.joints ?? {};
  const jointNames: string[] = [];
  let floatingRootJointName: string | null = null;

  for (const [jointName, joint] of Object.entries(joints)) {
    const jointType = String(joint?.jointType ?? '').toLowerCase();
    if (jointType === 'fixed') {
      continue;
    }

    if (jointType === 'floating') {
      if (!floatingRootJointName) {
        floatingRootJointName = jointName;
      }
      continue;
    }

    jointNames.push(jointName);
  }

  return {
    rootJointName: floatingRootJointName ?? DEFAULT_ROOT_JOINT_NAME,
    rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames,
  };
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function resolvePresetUrdfUrl(rawPath: string): string {
  const normalizedPath = normalizePath(rawPath);
  if (!normalizedPath) {
    throw new Error(`Invalid preset URDF path: ${rawPath}`);
  }

  return new URL(normalizedPath, document.baseURI).toString();
}

function buildRemoteResourceCandidates(requestedPath: string): string[] {
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return [trimmed];
  }

  if (isAbsoluteUrl(trimmed) && !trimmed.startsWith('package://')) {
    return [trimmed];
  }

  const normalizedCandidates = new Set<string>();
  if (trimmed.startsWith('package://')) {
    const withoutScheme = normalizePath(trimmed.replace(/^package:\/\//, ''));
    if (withoutScheme) {
      normalizedCandidates.add(withoutScheme);
      const tokens = withoutScheme.split('/');
      if (tokens.length > 1) {
        normalizedCandidates.add(tokens.slice(1).join('/'));
      }
    }
  } else {
    const normalized = normalizePath(trimmed);
    if (normalized) {
      normalizedCandidates.add(normalized);
    }
  }

  return [...normalizedCandidates];
}

function resolveRemoteResourceUrl(requestedPath: string, selectedUrdfPath: string): string | null {
  const candidates = buildRemoteResourceCandidates(requestedPath);
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1 && (candidates[0].startsWith('blob:') || candidates[0].startsWith('data:') || isAbsoluteUrl(candidates[0]))) {
    return candidates[0];
  }

  const urdfDirectory = getDirectoryPath(selectedUrdfPath);
  for (const candidate of candidates) {
    const attemptPath = urdfDirectory ? normalizePath(`${urdfDirectory}/${candidate}`) : candidate;
    if (!attemptPath) {
      continue;
    }

    try {
      return new URL(attemptPath, document.baseURI).toString();
    } catch {
      continue;
    }
  }

  return null;
}

function stripEmbeddedSceneLights(root: any): any {
  const lightsToRemove: any[] = [];
  root.traverse((child: unknown) => {
    const maybeLight = child as any;
    if (maybeLight?.isLight) {
      lightsToRemove.push(maybeLight);
    }
  });

  for (const light of lightsToRemove) {
    light.parent?.remove(light);
  }

  return root;
}

export class UrdfLoadService {
  private readonly objectUrls = new Set<string>();

  dispose(): void {
    this.revokeObjectUrls();
  }

  getAvailableUrdfPaths(fileMap: DroppedFileMap): string[] {
    return sortUrdfPaths(
      [...fileMap.keys()].filter((path) => path.toLowerCase().endsWith('.urdf')),
    );
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredUrdfPath?: string,
  ): Promise<LoadedRobotResult> {
    this.revokeObjectUrls();

    const urdfPaths = this.getAvailableUrdfPaths(fileMap);
    let selectedUrdfPath: string | null;

    if (preferredUrdfPath) {
      const normalizedPreferredPath = normalizePath(preferredUrdfPath);
      selectedUrdfPath =
        urdfPaths.find((path) => path === normalizedPreferredPath) ?? null;
      if (!selectedUrdfPath) {
        throw new Error(`Requested URDF not found in dropped files: ${preferredUrdfPath}`);
      }
    } else {
      selectedUrdfPath = selectPrimaryUrdfPath(urdfPaths);
    }

    if (!selectedUrdfPath) {
      throw new Error('No URDF file found. Drop a URDF file or folder containing one.');
    }

    const selectedUrdfFile = fileMap.get(selectedUrdfPath);
    if (!selectedUrdfFile) {
      throw new Error(`Selected URDF file is missing from file map: ${selectedUrdfPath}`);
    }

    const warnings = new Set<string>();
    if (!preferredUrdfPath && urdfPaths.length > 1) {
      warnings.add(
        `Multiple URDF files found. Auto-selected ${selectedUrdfPath}. Drop a narrower folder to choose another.`,
      );
    }

    const urdfContent = await selectedUrdfFile.text();
    const loader = new URDFLoader();
    loader.parseCollision = true;

    const blobUrlByPath = new Map<string, string>();
    const missingResourceWarnings = new Set<string>();

    const reportMissingResource = (requestedPath: string): void => {
      const normalized = normalizePath(requestedPath);
      if (!normalized || missingResourceWarnings.has(normalized)) {
        return;
      }

      missingResourceWarnings.add(normalized);
      warnings.add(`Missing resource: ${normalized}`);
    };

    const resolveBlobUrl = (fileKey: string): string => {
      const existingUrl = blobUrlByPath.get(fileKey);
      if (existingUrl) {
        return existingUrl;
      }

      const file = fileMap.get(fileKey);
      if (!file) {
        throw new Error(`File key was resolved but missing in map: ${fileKey}`);
      }

      const objectUrl = this.registerObjectUrl(file);
      blobUrlByPath.set(fileKey, objectUrl);
      return objectUrl;
    };

    loader.manager.setURLModifier((requestedUrl: string) => {
      const recoverableBlobPath = extractRecoverablePathFromBlobUrl(requestedUrl);
      if (requestedUrl.startsWith('blob:') && !recoverableBlobPath) {
        return requestedUrl;
      }

      const fileKey = resolveFileKeyForRequest(
        recoverableBlobPath ?? requestedUrl,
        selectedUrdfPath,
        fileMap,
      );
      if (!fileKey) {
        reportMissingResource(recoverableBlobPath ?? requestedUrl);
        return requestedUrl;
      }

      return resolveBlobUrl(fileKey);
    });

    loader.loadMeshCb = (
      requestedPath: string,
      manager: any,
      done: (object: unknown, error?: unknown) => void,
    ) => {
      const fileKey = resolveFileKeyForRequest(requestedPath, selectedUrdfPath, fileMap);
      if (!fileKey) {
        reportMissingResource(requestedPath);
        done(new Group());
        return;
      }

      const extension = getFileExtension(fileKey);
      const blobUrl = resolveBlobUrl(fileKey);

      const onError = (error: unknown): void => {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.add(`Failed to load mesh ${fileKey}: ${reason}`);
        done(new Group());
      };

      switch (extension) {
        case 'stl':
          new STLLoader(manager).load(
            blobUrl,
            (geometry: unknown) => {
              const material = new MeshPhongMaterial({ color: '#c2ccd5' });
              const mesh = new Mesh(geometry, material);
              done(mesh);
            },
            undefined,
            onError,
          );
          return;
        case 'obj':
          new OBJLoader(manager).load(
            blobUrl,
            (object: unknown) => done(object),
            undefined,
            onError,
          );
          return;
        case 'dae':
          new ColladaLoader(manager).load(
            blobUrl,
            (result: any) => done(stripEmbeddedSceneLights(result?.scene ?? new Group())),
            undefined,
            onError,
          );
          return;
        default:
          warnings.add(
            `Unsupported mesh format "${extension || 'unknown'}" for ${fileKey}. Skipped this mesh.`,
          );
          done(new Group());
      }
    };

    const urdfBlob = new Blob([urdfContent], { type: 'text/xml' });
    const urdfUrl = this.registerObjectUrl(urdfBlob);
    const robot = await this.loadUrdfWithUrl(loader, urdfUrl);
    const motionSchema = buildMotionSchema(robot);

    return {
      robot,
      robotName: robot.name || getBaseName(selectedUrdfPath).replace(/\.urdf$/i, ''),
      linkCount: robot.links ? Object.keys(robot.links).length : 0,
      jointCount: robot.joints ? Object.keys(robot.joints).length : 0,
      selectedUrdfPath,
      motionSchema,
      warnings: [...warnings],
    };
  }

  async loadFromPresetUrl(urdfPath: string): Promise<LoadedRobotResult> {
    this.revokeObjectUrls();

    const selectedUrdfPath = normalizePath(urdfPath);
    if (!selectedUrdfPath) {
      throw new Error(`Invalid preset URDF path: ${urdfPath}`);
    }

    const warnings = new Set<string>();
    const loader = new URDFLoader();
    loader.parseCollision = true;

    loader.manager.setURLModifier((requestedUrl: string) => {
      const recoverableBlobPath = extractRecoverablePathFromBlobUrl(requestedUrl);
      if (requestedUrl.startsWith('blob:') && !recoverableBlobPath) {
        return requestedUrl;
      }

      const resolvedUrl = resolveRemoteResourceUrl(
        recoverableBlobPath ?? requestedUrl,
        selectedUrdfPath,
      );
      if (!resolvedUrl) {
        warnings.add(`Missing resource: ${recoverableBlobPath ?? requestedUrl}`);
        return requestedUrl;
      }

      return resolvedUrl;
    });

    loader.loadMeshCb = (
      requestedPath: string,
      manager: any,
      done: (object: unknown, error?: unknown) => void,
    ) => {
      const resolvedUrl = resolveRemoteResourceUrl(requestedPath, selectedUrdfPath);
      if (!resolvedUrl) {
        warnings.add(`Missing resource: ${requestedPath}`);
        done(new Group());
        return;
      }

      const extension = getFileExtension(requestedPath);
      const onError = (error: unknown): void => {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.add(`Failed to load mesh ${requestedPath}: ${reason}`);
        done(new Group());
      };

      switch (extension) {
        case 'stl':
          new STLLoader(manager).load(
            resolvedUrl,
            (geometry: unknown) => {
              const material = new MeshPhongMaterial({ color: '#c2ccd5' });
              const mesh = new Mesh(geometry, material);
              done(mesh);
            },
            undefined,
            onError,
          );
          return;
        case 'obj':
          new OBJLoader(manager).load(
            resolvedUrl,
            (object: unknown) => done(object),
            undefined,
            onError,
          );
          return;
        case 'dae':
          new ColladaLoader(manager).load(
            resolvedUrl,
            (result: any) => done(stripEmbeddedSceneLights(result?.scene ?? new Group())),
            undefined,
            onError,
          );
          return;
        default:
          warnings.add(
            `Unsupported mesh format "${extension || 'unknown'}" for ${requestedPath}. Skipped this mesh.`,
          );
          done(new Group());
      }
    };

    const urdfUrl = resolvePresetUrdfUrl(selectedUrdfPath);
    const robot = await this.loadUrdfWithUrl(loader, urdfUrl);
    const motionSchema = buildMotionSchema(robot);

    return {
      robot,
      robotName: robot.name || getBaseName(selectedUrdfPath).replace(/\.urdf$/i, ''),
      linkCount: robot.links ? Object.keys(robot.links).length : 0,
      jointCount: robot.joints ? Object.keys(robot.joints).length : 0,
      selectedUrdfPath,
      motionSchema,
      warnings: [...warnings],
    };
  }

  private registerObjectUrl(blob: Blob | File): string {
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.add(objectUrl);
    return objectUrl;
  }

  private revokeObjectUrls(): void {
    for (const objectUrl of this.objectUrls) {
      URL.revokeObjectURL(objectUrl);
    }
    this.objectUrls.clear();
  }

  private loadUrdfWithUrl(loader: any, urdfUrl: string): Promise<UrdfRobotLike> {
    return new Promise((resolve, reject) => {
      loader.load(
        urdfUrl,
        (robot: unknown) => {
          const loadedRobot = robot as UrdfRobotLike;
          loadedRobot.traverse((child: unknown) => {
            const maybeMesh = child as any;
            if (maybeMesh.isMesh) {
              maybeMesh.castShadow = true;
              maybeMesh.receiveShadow = true;
            }
          });
          resolve(loadedRobot);
        },
        undefined,
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          reject(new Error(`URDF loading failed: ${reason}`));
        },
      );
    });
  }
}

export { stripEmbeddedSceneLights };
