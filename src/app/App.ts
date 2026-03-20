import type {
  DroppedFileMap,
  LoadedRobotResult,
  MotionClip,
  ViewMode,
  ViewerState,
} from '../types/viewer';
import { Box3, Vector3 } from 'three';
import { dataTransferToFileMap, fileListToFileMap } from '../io/drop/dataTransferToFileMap';
import { registerDropHandlers } from '../io/drop/registerDropHandlers';
import {
  BVH_LINEAR_UNITS,
  BvhMotionService,
  type BvhLinearUnit,
} from '../io/motion/BvhMotionService';
import { CsvMotionService } from '../io/motion/CsvMotionService';
import { MimicKitMotionService } from '../io/motion/MimicKitMotionService';
import { GmrMotionService } from '../io/motion/GmrMotionService';
import { SmplMotionService } from '../io/motion/SmplMotionService';
import { DEFAULT_ROOT_COMPONENT_COUNT } from '../io/motion/MotionSchema';
import { ObjLoadService, type ObjModelLoadResult } from '../io/object/ObjLoadService';
import { getBaseName, normalizePath } from '../io/urdf/pathResolver';
import { UrdfLoadService } from '../io/urdf/UrdfLoadService';
import { BvhMotionPlayer } from '../motion/BvhMotionPlayer';
import { G1MotionPlayer, type MotionFrameSnapshot } from '../motion/G1MotionPlayer';
import { formatMissingObjectModelWarning } from '../motion/objectWarnings';
import { SmplMotionPlayer } from '../motion/SmplMotionPlayer';
import { SceneController } from '../viewer/SceneController';
import { getStateCopy } from './state';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required element not found: #${id}`);
  }

  return element as T;
}

function isBvhLinearUnit(value: string): value is BvhLinearUnit {
  return BVH_LINEAR_UNITS.includes(value as BvhLinearUnit);
}

function appendTextWithHttpLinks(element: HTMLElement, text: string): void {
  element.replaceChildren();

  const urlPattern = /https?:\/\/[^\s]+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0];
    const startIndex = match.index;

    if (startIndex > cursor) {
      element.append(document.createTextNode(text.slice(cursor, startIndex)));
    }

    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    element.append(link);

    cursor = startIndex + url.length;
  }

  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}

interface PresetAssetFile {
  path: string;
  mapAs: string;
}

interface PresetModelDefinition {
  files?: PresetAssetFile[];
  urdfPath?: string;
  selectedUrdfPath?: string;
}

interface PresetMotionDefinition {
  kind: 'csv' | 'mimickit' | 'gmr' | 'bvh' | 'smpl';
  files?: PresetAssetFile[];
  path?: string;
  selectedMotionPath?: string;
}

interface ViewerPresetDefinition {
  id: string;
  label: string;
  description?: string;
  model?: PresetModelDefinition;
  motion?: PresetMotionDefinition;
}

interface ViewerPresetManifest {
  presets: ViewerPresetDefinition[];
  capturedObjects: PresetAssetFile[];
}

type UrdfMotionKind = 'csv' | 'mimickit' | 'gmr';
type ViewerMotionKind = UrdfMotionKind | 'bvh' | 'smpl';

function isUrdfMotionKind(kind: ViewerMotionKind | null): kind is UrdfMotionKind {
  return kind === 'csv' || kind === 'mimickit' || kind === 'gmr';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${context} cannot be empty.`);
  }

  return trimmed;
}

function normalizePresetFetchPath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function normalizePresetMapPath(rawPath: string): string {
  const normalized = normalizePath(rawPath);
  if (normalized) {
    return normalized;
  }

  const baseName = getBaseName(rawPath);
  if (baseName) {
    return baseName;
  }

  throw new Error(`Invalid preset file path: ${rawPath}`);
}

function parsePresetAssetFile(value: unknown, context: string): PresetAssetFile {
  if (typeof value === 'string') {
    const path = normalizePresetFetchPath(parseNonEmptyString(value, `${context}.path`));
    if (!path) {
      throw new Error(`${context}.path cannot be empty.`);
    }

    return {
      path,
      mapAs: normalizePresetMapPath(path),
    };
  }

  if (!isRecord(value)) {
    throw new Error(`${context} must be a string or object.`);
  }

  const path = normalizePresetFetchPath(parseNonEmptyString(value.path, `${context}.path`));
  if (!path) {
    throw new Error(`${context}.path cannot be empty.`);
  }

  const rawMapPath = typeof value.mapAs === 'string' ? value.mapAs : path;
  return {
    path,
    mapAs: normalizePresetMapPath(rawMapPath),
  };
}

function parsePresetAssetFiles(value: unknown, context: string): PresetAssetFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }

  return value.map((item, index) => parsePresetAssetFile(item, `${context}[${index}]`));
}

function parseOptionalPresetAssetFiles(value: unknown, context: string): PresetAssetFile[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parsePresetAssetFiles(value, context);
}

function parseOptionalNormalizedPath(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const rawPath = parseNonEmptyString(value, context);
  const normalized = normalizePath(rawPath);
  if (!normalized) {
    throw new Error(`${context} is invalid.`);
  }

  return normalized;
}

function parsePresetManifest(value: unknown): ViewerPresetManifest {
  if (!isRecord(value) || !Array.isArray(value.presets)) {
    throw new Error('Preset manifest must contain a presets array.');
  }

  const presets = value.presets.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`presets[${index}] must be an object.`);
    }

    const id = parseNonEmptyString(item.id, `presets[${index}].id`);
    const label = parseNonEmptyString(item.label, `presets[${index}].label`);
    const description =
      item.description === undefined
        ? undefined
        : parseNonEmptyString(item.description, `presets[${index}].description`);

    let model: PresetModelDefinition | undefined;
    if (item.model !== undefined) {
      if (!isRecord(item.model)) {
        throw new Error(`presets[${index}].model must be an object.`);
      }

      model = {
        files: parseOptionalPresetAssetFiles(item.model.files, `presets[${index}].model.files`),
        urdfPath: parseOptionalNormalizedPath(
          item.model.urdfPath,
          `presets[${index}].model.urdfPath`,
        ),
        selectedUrdfPath: parseOptionalNormalizedPath(
          item.model.selectedUrdfPath,
          `presets[${index}].model.selectedUrdfPath`,
        ),
      };

      if ((!model.files || model.files.length === 0) && !model.urdfPath) {
        throw new Error(
          `presets[${index}].model must include either files[] or urdfPath.`,
        );
      }
    }

    let motion: PresetMotionDefinition | undefined;
    if (item.motion !== undefined) {
      if (!isRecord(item.motion)) {
        throw new Error(`presets[${index}].motion must be an object.`);
      }

      const kind = parseNonEmptyString(item.motion.kind, `presets[${index}].motion.kind`).toLowerCase();
      if (kind !== 'csv' && kind !== 'mimickit' && kind !== 'gmr' && kind !== 'bvh' && kind !== 'smpl') {
        throw new Error(
          `presets[${index}].motion.kind must be "csv", "mimickit", "gmr", "bvh", or "smpl".`,
        );
      }

      motion = {
        kind,
        files: parseOptionalPresetAssetFiles(item.motion.files, `presets[${index}].motion.files`),
        path: parseOptionalNormalizedPath(
          item.motion.path,
          `presets[${index}].motion.path`,
        ),
        selectedMotionPath: parseOptionalNormalizedPath(
          item.motion.selectedMotionPath,
          `presets[${index}].motion.selectedMotionPath`,
        ),
      };

      if ((!motion.files || motion.files.length === 0) && !motion.path) {
        throw new Error(
          `presets[${index}].motion must include either files[] or path.`,
        );
      }
    }

    if (!model && !motion) {
      throw new Error(`presets[${index}] must include model and/or motion.`);
    }

    return {
      id,
      label,
      description,
      model,
      motion,
    };
  });

  let capturedObjects: PresetAssetFile[] = [];
  if (value.capturedObjects !== undefined && value.capturedObjects !== null) {
    if (!Array.isArray(value.capturedObjects)) {
      throw new Error('capturedObjects must be an array.');
    }

    capturedObjects = value.capturedObjects.map((item, index) =>
      parsePresetAssetFile(item, `capturedObjects[${index}]`),
    );
  }

  return { presets, capturedObjects };
}

const DEFAULT_CAPTURED_OBJECT_FILE_NAMES = [
  'clothesstand_cleaned_simplified.obj',
  'floorlamp_cleaned_simplified.obj',
  'largebox_cleaned_simplified.obj',
  'largetable_cleaned_simplified.obj',
  'monitor_cleaned_simplified.obj',
  'mop_cleaned_simplified.obj',
  'mop_cleaned_simplified_top.obj',
  'mop_cleaned_simplified_bottom.obj',
  'plasticbox_cleaned_simplified.obj',
  'smallbox_cleaned_simplified.obj',
  'smalltable_cleaned_simplified.obj',
  'suitcase_cleaned_simplified.obj',
  'trashcan_cleaned_simplified.obj',
  'tripod_cleaned_simplified.obj',
  'vacuum_cleaned_simplified.obj',
  'vacuum_cleaned_simplified_top.obj',
  'vacuum_cleaned_simplified_bottom.obj',
  'whitechair_cleaned_simplified.obj',
  'woodchair_cleaned_simplified.obj',
] as const;

function buildDefaultCapturedObjectPresetFiles(): PresetAssetFile[] {
  return DEFAULT_CAPTURED_OBJECT_FILE_NAMES.map((fileName) => {
    const path = `presets/omomo/captured_objects/${fileName}`;
    return {
      path,
      mapAs: normalizePresetMapPath(path),
    };
  });
}

function normalizeObjectToken(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
  const core = normalized
    .replace(/_cleaned_simplified(?:_(top|bottom))?$/, '')
    .replace(/_(top|bottom)$/, '');
  return core || null;
}

function stripExtension(pathOrFileName: string): string {
  return pathOrFileName.replace(/\.[^/.]+$/, '');
}

function parseCapturedObjNameFromPath(pathOrFileName: string): string | null {
  const baseName = stripExtension(getBaseName(pathOrFileName) || pathOrFileName).toLowerCase();
  const coreName = baseName
    .replace(/_cleaned_simplified(?:_(top|bottom))?$/, '')
    .replace(/_(top|bottom)$/, '');
  return normalizeObjectToken(coreName);
}

function scoreCapturedObjPath(pathOrFileName: string): number {
  const baseName = stripExtension(getBaseName(pathOrFileName) || pathOrFileName).toLowerCase();
  if (/_cleaned_simplified$/.test(baseName)) {
    return 0;
  }
  if (/_cleaned_simplified_top$/.test(baseName)) {
    return 1;
  }
  if (/_cleaned_simplified_bottom$/.test(baseName)) {
    return 2;
  }
  return 3;
}

function formatCapturedObjLabel(pathOrFileName: string): string {
  const baseName = stripExtension(getBaseName(pathOrFileName) || pathOrFileName);
  const isTopPart =
    /_cleaned_simplified_top$/i.test(baseName) || /_top$/i.test(baseName);
  const isBottomPart =
    /_cleaned_simplified_bottom$/i.test(baseName) || /_bottom$/i.test(baseName);
  const core = baseName
    .replace(/_cleaned_simplified(?:_(top|bottom))?$/i, '')
    .replace(/_(top|bottom)$/i, '')
    .replace(/_/g, ' ');

  if (isTopPart) {
    return `${core} (top)`;
  }
  if (isBottomPart) {
    return `${core} (bottom)`;
  }
  return core;
}

function inferSmplGenderFromPath(path: string): string | null {
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

function formatSmplModelLabel(path: string): string {
  const baseName = getBaseName(path) || path;
  const gender = inferSmplGenderFromPath(path);
  if (!gender) {
    return baseName;
  }
  return `${baseName} (${gender})`;
}

function mergeUniquePaths(primary: string[], secondary: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of [...primary, ...secondary]) {
    const normalized = normalizePath(rawPath);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function dedupePresetAssetsByMapAs(files: PresetAssetFile[]): PresetAssetFile[] {
  const deduped = new Map<string, PresetAssetFile>();
  for (const file of files) {
    const normalizedMapPath = normalizePath(file.mapAs);
    if (!normalizedMapPath || deduped.has(normalizedMapPath)) {
      continue;
    }
    deduped.set(normalizedMapPath, {
      path: file.path,
      mapAs: normalizedMapPath,
    });
  }
  return [...deduped.values()];
}

function isUrdfModelPath(path: string): boolean {
  return normalizePath(path).toLowerCase().endsWith('.urdf');
}

function isSmplModelPath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  return normalized.endsWith('.npz') || normalized.endsWith('.pkl');
}

function collectPresetUrdfModels(manifest: ViewerPresetManifest | null): PresetAssetFile[] {
  if (!manifest) {
    return [];
  }

  const collected: PresetAssetFile[] = [];
  for (const preset of manifest.presets) {
    const model = preset.model;
    if (!model) {
      continue;
    }

    if (model.urdfPath && isUrdfModelPath(model.urdfPath)) {
      const normalizedPath = normalizePath(model.urdfPath);
      if (normalizedPath) {
        collected.push({
          path: normalizedPath,
          mapAs: normalizedPath,
        });
      }
    }

    for (const file of model.files ?? []) {
      if (!isUrdfModelPath(file.mapAs)) {
        continue;
      }
      collected.push(file);
    }
  }

  return dedupePresetAssetsByMapAs(collected);
}

function collectPresetSmplModels(manifest: ViewerPresetManifest | null): PresetAssetFile[] {
  if (!manifest) {
    return [];
  }

  const collected: PresetAssetFile[] = [];
  for (const preset of manifest.presets) {
    const model = preset.model;
    if (!model) {
      continue;
    }

    for (const file of model.files ?? []) {
      if (!isSmplModelPath(file.mapAs)) {
        continue;
      }
      collected.push(file);
    }
  }

  return dedupePresetAssetsByMapAs(collected);
}

type SelectableModelKind = 'urdf' | 'smpl' | 'bvh';
type SelectableMotionKind = 'csv' | 'mimickit' | 'gmr' | 'bvh' | 'smpl';

interface SelectableModelOption {
  key: string;
  label: string;
  kind: SelectableModelKind;
  path: string;
  bindingTag: string | null;
  source: 'preset' | 'dropped' | 'builtin';
  files?: PresetAssetFile[];
  description?: string;
}

interface SelectableMotionOption {
  key: string;
  label: string;
  kind: SelectableMotionKind;
  selectedMotionPath: string;
  files: PresetAssetFile[];
  bindingTags: string[];
  description?: string;
}

const BVH_PREVIEW_MODEL_KEY = 'builtin:bvh-preview';

function buildPresetAssetFileFromPath(path: string): PresetAssetFile {
  return {
    path: normalizePresetFetchPath(path),
    mapAs: normalizePresetMapPath(path),
  };
}

function inferUrdfBindingTag(path: string): string | null {
  const normalized = normalizePath(path).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes('/go2/') ||
    normalized.includes('go2_description') ||
    normalized.includes('/go2_')
  ) {
    return 'urdf:go2';
  }
  if (
    normalized.includes('/g1/') ||
    normalized.includes('g1_description') ||
    normalized.includes('/g1_')
  ) {
    return 'urdf:g1';
  }
  if (normalized.includes('h1_2')) {
    return 'urdf:h1_2';
  }
  if (normalized.includes('/h1/') || normalized.includes('h1_description')) {
    return 'urdf:h1';
  }

  return null;
}

function inferSmplBindingTag(path: string): string {
  const normalized = normalizePath(path).toLowerCase();
  if (normalized.includes('smplx')) {
    return 'smpl:smplx';
  }
  if (normalized.includes('smplh')) {
    return 'smpl:smplh';
  }
  return 'smpl:smpl';
}

function inferModelBindingTag(kind: SelectableModelKind, path: string): string | null {
  if (kind === 'bvh') {
    return 'bvh';
  }
  if (kind === 'smpl') {
    return inferSmplBindingTag(path);
  }
  return inferUrdfBindingTag(path);
}

function formatSelectableModelLabel(kind: SelectableModelKind, path: string): string {
  if (kind === 'bvh') {
    return 'BVH Preview';
  }

  if (kind === 'smpl') {
    return `SMPL · ${formatSmplModelLabel(path)}`;
  }

  const bindingTag = inferUrdfBindingTag(path);
  if (bindingTag === 'urdf:g1') {
    return 'URDF · G1';
  }
  if (bindingTag === 'urdf:go2') {
    return 'URDF · Go2';
  }
  if (bindingTag === 'urdf:h1') {
    return 'URDF · H1';
  }
  if (bindingTag === 'urdf:h1_2') {
    return 'URDF · H1-2';
  }

  return `URDF · ${getBaseName(path) || path}`;
}

function formatSelectableMotionLabel(kind: SelectableMotionKind, path: string): string {
  const baseName = getBaseName(path) || path;
  if (kind === 'csv') {
    return `CSV · ${baseName}`;
  }
  if (kind === 'mimickit') {
    return `MimicKit · ${baseName}`;
  }
  if (kind === 'gmr') {
    return `GMR · ${baseName}`;
  }
  if (kind === 'bvh') {
    return `BVH · ${baseName}`;
  }
  return `SMPL · ${baseName}`;
}

function resolvePresetModelSelection(
  model: PresetModelDefinition,
): {
  kind: 'urdf' | 'smpl';
  path: string;
  files?: PresetAssetFile[];
} | null {
  const urdfFiles = (model.files ?? []).filter((file) => isUrdfModelPath(file.mapAs));
  if (model.urdfPath || urdfFiles.length > 0) {
    const path = model.selectedUrdfPath ?? model.urdfPath ?? urdfFiles[0]?.mapAs ?? '';
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return null;
    }
    return {
      kind: 'urdf',
      path: normalizedPath,
      files: model.files,
    };
  }

  const smplFiles = (model.files ?? []).filter((file) => isSmplModelPath(file.mapAs));
  if (smplFiles.length > 0) {
    return {
      kind: 'smpl',
      path: smplFiles[0]?.mapAs ?? '',
      files: model.files,
    };
  }

  return null;
}

function resolvePresetMotionFiles(motion: PresetMotionDefinition): PresetAssetFile[] {
  if (motion.files && motion.files.length > 0) {
    return motion.files;
  }
  if (motion.path) {
    return [buildPresetAssetFileFromPath(motion.path)];
  }
  return [];
}

function resolvePresetMotionPath(
  motion: PresetMotionDefinition,
  files: PresetAssetFile[],
): string | null {
  const preferredPath =
    motion.selectedMotionPath ?? (motion.path ? normalizePresetMapPath(motion.path) : null);
  if (preferredPath) {
    return preferredPath;
  }
  return files[0]?.mapAs ?? null;
}

function inferMotionBindingTags(
  kind: SelectableMotionKind,
  motionPath: string,
  pairedModelPath?: string | null,
): string[] {
  const tags = new Set<string>();

  if (kind === 'bvh') {
    tags.add('bvh');
  } else if (kind === 'smpl') {
    tags.add(pairedModelPath ? inferSmplBindingTag(pairedModelPath) : inferSmplBindingTag(motionPath));
  } else {
    const inferred = pairedModelPath ? inferUrdfBindingTag(pairedModelPath) : inferUrdfBindingTag(motionPath);
    if (inferred) {
      tags.add(inferred);
    }
  }

  return [...tags];
}

function collectPresetModelOptions(manifest: ViewerPresetManifest | null): SelectableModelOption[] {
  if (!manifest) {
    return [];
  }

  const options = new Map<string, SelectableModelOption>();
  let hasBvhMotion = false;

  for (const preset of manifest.presets) {
    if (preset.motion?.kind === 'bvh') {
      hasBvhMotion = true;
    }

    if (!preset.model) {
      continue;
    }

    const selection = resolvePresetModelSelection(preset.model);
    if (!selection || !selection.path) {
      continue;
    }

    const key = `${selection.kind}:${selection.path}`;
    if (options.has(key)) {
      continue;
    }

    options.set(key, {
      key,
      label: formatSelectableModelLabel(selection.kind, selection.path),
      kind: selection.kind,
      path: selection.path,
      bindingTag: inferModelBindingTag(selection.kind, selection.path),
      source: 'preset',
      files: selection.files,
      description: preset.description,
    });
  }

  if (hasBvhMotion) {
    options.set(BVH_PREVIEW_MODEL_KEY, {
      key: BVH_PREVIEW_MODEL_KEY,
      label: 'BVH Preview',
      kind: 'bvh',
      path: BVH_PREVIEW_MODEL_KEY,
      bindingTag: 'bvh',
      source: 'builtin',
      description: 'Built-in BVH preview skeleton.',
    });
  }

  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function collectPresetMotionOptions(manifest: ViewerPresetManifest | null): SelectableMotionOption[] {
  if (!manifest) {
    return [];
  }

  const options = new Map<string, SelectableMotionOption>();
  for (const preset of manifest.presets) {
    if (!preset.motion) {
      continue;
    }

    const files = resolvePresetMotionFiles(preset.motion);
    if (files.length === 0) {
      continue;
    }

    const selectedMotionPath = resolvePresetMotionPath(preset.motion, files);
    if (!selectedMotionPath) {
      continue;
    }

    const pairedModel = preset.model ? resolvePresetModelSelection(preset.model) : null;
    const kind = preset.motion.kind as SelectableMotionKind;
    const key = `${kind}:${selectedMotionPath}`;
    const bindingTags = inferMotionBindingTags(kind, selectedMotionPath, pairedModel?.path ?? null);
    const existing = options.get(key);
    if (existing) {
      existing.bindingTags = [...new Set([...existing.bindingTags, ...bindingTags])];
      continue;
    }

    options.set(key, {
      key,
      label: formatSelectableMotionLabel(kind, selectedMotionPath),
      kind,
      selectedMotionPath,
      files,
      bindingTags,
      description: preset.description,
    });
  }

  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export class AppController {
  private readonly appRoot: HTMLDivElement;
  private readonly sceneController: SceneController;
  private readonly urdfLoadService: UrdfLoadService;
  private readonly csvMotionService: CsvMotionService;
  private readonly mimicKitMotionService: MimicKitMotionService;
  private readonly gmrMotionService: GmrMotionService;
  private readonly bvhMotionService: BvhMotionService;
  private readonly smplMotionService: SmplMotionService;
  private readonly objLoadService: ObjLoadService;
  private readonly motionPlayer: G1MotionPlayer;
  private readonly bvhMotionPlayer: BvhMotionPlayer;
  private readonly smplMotionPlayer: SmplMotionPlayer;
  private readonly dropHint: HTMLParagraphElement;
  private readonly dropOverlayDockButton: HTMLButtonElement;
  private readonly stateChip: HTMLSpanElement;
  private readonly statusTitle: HTMLElement;
  private readonly modelTitle: HTMLParagraphElement;
  private readonly statusDetail: HTMLParagraphElement;
  private readonly statusWarnings: HTMLUListElement;
  private readonly motionWarningsList: HTMLUListElement;
  private readonly urdfSelect: HTMLSelectElement;
  private readonly smplModelSelect: HTMLSelectElement;
  private readonly urdfVisualControls: HTMLDivElement;
  private readonly showVisualButton: HTMLButtonElement;
  private readonly showCollisionButton: HTMLButtonElement;
  private readonly viewModeButton: HTMLButtonElement;
  private readonly modePropsPanel: HTMLElement;
  private readonly modePropsList: HTMLDivElement;
  private readonly motionControlsSection: HTMLElement;
  private readonly motionPlayButton: HTMLButtonElement;
  private readonly motionResetButton: HTMLButtonElement;
  private readonly motionFpsControl: HTMLDivElement;
  private readonly motionFpsInput: HTMLInputElement;
  private readonly motionFrameSlider: HTMLInputElement;
  private readonly motionTitle: HTMLParagraphElement;
  private readonly motionFrameLabel: HTMLSpanElement;
  private readonly folderInput: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private readonly pickFolderButton: HTMLButtonElement;
  private readonly pickFilesButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly presetLoadButton: HTMLButtonElement;
  private readonly objSelect: HTMLSelectElement;
  private readonly exportMotionButton: HTMLButtonElement;
  private readonly insertKeyframeButton: HTMLButtonElement;
  private readonly prevKeyframeButton: HTMLButtonElement;
  private readonly nextKeyframeButton: HTMLButtonElement;
  private readonly motionFrameCountInput: HTMLInputElement;
  private readonly datasetPanel: HTMLElement;
  private readonly datasetPanelMinimizeBtn: HTMLButtonElement;
  private readonly statusPanel: HTMLElement;
  private readonly statusPanelMinimizeBtn: HTMLButtonElement;
  private readonly jointPanel: HTMLElement;
  private readonly jointPanelToggle: HTMLButtonElement;
  private readonly jointPanelContent: HTMLDivElement;
  private readonly jointList: HTMLDivElement;
  private isJointPanelCollapsed = false;
  private isDatasetPanelMinimized = false;
  private isStatusPanelMinimized = false;
  private readonly removeDropHandlers: () => void;
  private viewerState: ViewerState = 'idle';
  private titleOverride: string | null = null;
  private modelTitleOverride: string | null = null;
  private detailOverride: string | null = null;
  private dropHintOverride: string | null = null;
  private warnings: string[] = [];
  private sceneWarning: string | null = null;
  private droppedFileMap: DroppedFileMap | null = null;
  private availableUrdfPaths: string[] = [];
  private selectedUrdfPath: string | null = null;
  private showVisual = true;
  private showCollision = false;
  private lastLoadResult: LoadedRobotResult | null = null;
  private currentMotionClip: MotionClip | null = null;
  private currentBvhMotion:
    | {
        name: string;
        sourcePath: string;
        frameCount: number;
        fps: number;
        jointCount: number;
        linearUnit: BvhLinearUnit;
      }
    | null = null;
  private currentBvhFileMap: DroppedFileMap | null = null;
  private currentSmplModel:
    | {
        modelName: string;
        modelSourcePath: string;
        modelGender: string | null;
        jointCount: number;
        vertexCount: number;
      }
    | null = null;
  private currentSmplMotion:
    | {
        modelName: string;
        modelSourcePath: string;
        motionName: string;
        motionSourcePath: string;
        frameCount: number;
        fps: number;
        jointCount: number;
        vertexCount: number;
        motionGender: string | null;
        modelGender: string | null;
        hasObjectMotion: boolean;
        objectName: string | null;
      }
    | null = null;
  private currentSmplFileMap: DroppedFileMap | null = null;
  private currentObjModel:
    | {
        modelName: string;
        modelSourcePath: string;
        meshCount: number;
      }
    | null = null;
  private currentObjFileMap: DroppedFileMap | null = null;
  private currentMotionKind: ViewerMotionKind | null = null;
  private currentMotionSourcePath: string | null = null;
  private motionWarnings: string[] = [];
  private motionFrameSnapshot: MotionFrameSnapshot | null = null;
  private isDropOverlayDocked = false;
  private isMotionPlaying = false;
  private bvhLinearUnit: BvhLinearUnit = 'm';
  private viewMode: ViewMode = 'root_lock';
  private smplDisplayMode: 'mesh' | 'skeleton' = 'mesh';
  private currentSmplDisplayNodes:
    | {
        skinnedMesh: any;
        skeletonHelper: any;
      }
    | null = null;
  private availableSmplModelPaths: string[] = [];
  private selectedSmplModelPath: string | null = null;
  private recoverReadyTimer: number | null = null;
  private recoverableDropHint: string | null = null;
  private presetManifest: ViewerPresetManifest | null = null;
  private presetUrdfCatalog: PresetAssetFile[] = [];
  private presetSmplModelCatalog: PresetAssetFile[] = [];
  private presetModelCatalog: SelectableModelOption[] = [];
  private presetMotionCatalog: SelectableMotionOption[] = [];
  private capturedObjCatalog: PresetAssetFile[] = buildDefaultCapturedObjectPresetFiles();
  private droppedUrdfFileMap: DroppedFileMap = new Map();
  private droppedSmplModelFileMap: DroppedFileMap = new Map();
  private droppedCapturedObjFileMap: DroppedFileMap = new Map();
  private selectedModelOptionKey: string | null = null;
  private selectedMotionOptionKey: string | null = null;
  private selectedCapturedObjPath: string | null = null;
  private isPresetLoading = false;
  private isObjCatalogLoading = false;
  private keyframes: Set<number> = new Set();
  private keyframeMarkersContainer: HTMLElement | null = null;

  private readonly onWindowResize = (): void => {
    this.sceneController.resize();
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.repeat) {
      return;
    }

    const eventTarget = event.target as HTMLElement | null;
    if (
      eventTarget?.tagName === 'INPUT' ||
      eventTarget?.tagName === 'TEXTAREA' ||
      eventTarget?.isContentEditable
    ) {
      return;
    }

    if (event.key === 'Shift' && this.currentSmplModel && this.currentSmplDisplayNodes) {
      event.preventDefault();
      this.toggleSmplDisplayMode();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      this.toggleViewMode();
      return;
    }

    if (event.code === 'Space' && this.hasAnyMotion()) {
      event.preventDefault();
      if (this.isMotionPlaying) {
        this.pauseActiveMotion();
      } else {
        this.playActiveMotion();
      }
      return;
    }

    if ((event.key === 'r' || event.key === 'R') && this.hasAnyMotion()) {
      event.preventDefault();
      this.resetActiveMotion();
    }
  };

  private readonly onFolderInputChange = (): void => {
    void this.handlePickedFiles(this.folderInput.files);
  };

  private readonly onFileInputChange = (): void => {
    void this.handlePickedFiles(this.fileInput.files);
  };

  private readonly onPickFolderClick = (): void => {
    this.folderInput.value = '';
    this.folderInput.click();
  };

  private readonly onPickFilesClick = (): void => {
    this.fileInput.value = '';
    this.fileInput.click();
  };

  private readonly onResetClick = (): void => {
    this.resetViewer();
  };

  private readonly onDropOverlayDockClick = (): void => {
    if (this.viewerState === 'playing') {
      return;
    }

    this.isDropOverlayDocked = !this.isDropOverlayDocked;
    this.syncDropOverlayDockState();
  };

  private readonly onPresetSelectChange = (): void => {
    this.syncPresetControls();
    const motionKey = this.presetSelect.value;
    this.selectedMotionOptionKey = motionKey || null;
    if (!motionKey || this.isPresetLoading) {
      return;
    }

    void this.loadMotionOptionByKey(motionKey);
  };

  private readonly onPresetLoadClick = (): void => {
    const motionKey = this.presetSelect.value;
    if (!motionKey || this.isPresetLoading) {
      return;
    }

    void this.loadMotionOptionByKey(motionKey);
  };

  private readonly onObjSelectChange = (): void => {
    const selectedObjPath = this.objSelect.value;
    this.selectedCapturedObjPath = selectedObjPath ? normalizePath(selectedObjPath) : '';
    this.syncObjSelectionToCurrentModel();
  };

  private readonly onShowVisualClick = (): void => {
    this.showVisual = !this.showVisual;
    this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);
    this.applySmplDisplayMode();
    this.syncVisibilityButtons();
  };

  private readonly onShowCollisionClick = (): void => {
    this.showCollision = !this.showCollision;
    this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);
    this.applySmplDisplayMode();
    this.syncVisibilityButtons();
  };

  private readonly onViewModeClick = (): void => {
    this.toggleViewMode();
  };

  private readonly onModePropsSmplRenderClick = (): void => {
    this.toggleSmplDisplayMode();
  };

  private readonly onModePropsBvhUnitChange = (event: Event): void => {
    if (this.viewerState === 'loading') {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    const selectedValue = target.value;
    if (!isBvhLinearUnit(selectedValue)) {
      target.value = this.bvhLinearUnit;
      return;
    }

    const nextUnit = selectedValue;
    if (nextUnit === this.bvhLinearUnit) {
      return;
    }

    if (this.currentMotionKind === 'bvh' && this.currentBvhFileMap) {
      void this.reloadCurrentBvhWithUnit(nextUnit);
      return;
    }

    this.bvhLinearUnit = nextUnit;
    this.syncMotionControls();
    if (this.isModelActiveState()) {
      this.renderCurrentReadyState();
    }
  };

  private readonly onUrdfSelectChange = (): void => {
    if (this.viewerState === 'loading') {
      this.renderUrdfList();
      return;
    }

    const modelKey = this.urdfSelect.value;
    if (!modelKey) {
      this.selectedModelOptionKey = null;
      this.selectedMotionOptionKey = null;
      this.renderUrdfList();
      return;
    }

    if (modelKey === this.getCurrentModelOptionKey()) {
      return;
    }

    void this.loadModelOptionByKey(modelKey);
  };

  private readonly onSmplModelSelectChange = (): void => {
    if (this.viewerState === 'loading') {
      this.renderSmplModelList();
      return;
    }

    const smplModelPath = this.smplModelSelect.value;
    if (!smplModelPath || smplModelPath === this.selectedSmplModelPath) {
      return;
    }

    this.selectedModelOptionKey = `smpl:${normalizePath(smplModelPath)}`;
    void this.loadSelectedSmplModel(smplModelPath);
  };

  private readonly onMotionPlayClick = (): void => {
    if (!this.hasAnyMotion()) {
      return;
    }

    if (this.isMotionPlaying) {
      this.pauseActiveMotion();
      return;
    }

    this.playActiveMotion();
  };

  private readonly onMotionResetClick = (): void => {
    if (!this.hasAnyMotion()) {
      return;
    }

    this.resetActiveMotion();
  };

  private readonly onMotionFrameInput = (): void => {
    if (!this.hasAnyMotion()) {
      return;
    }

    const frameIndex = Number(this.motionFrameSlider.value);
    if (!Number.isFinite(frameIndex)) {
      return;
    }

    this.seekActiveMotion(frameIndex);
  };

  private readonly onMotionFpsInput = (): void => {
    const rawFps = Number(this.motionFpsInput.value);
    if (!Number.isFinite(rawFps) || rawFps <= 0) {
      return;
    }

    if (isUrdfMotionKind(this.currentMotionKind) && this.currentMotionClip) {
      this.applyUrdfMotionFps(rawFps);
      return;
    }
    if (this.currentMotionKind === 'bvh' && this.currentBvhMotion) {
      this.applyBvhMotionFps(rawFps);
      return;
    }
    if (this.currentMotionKind === 'smpl' && this.currentSmplMotion) {
      this.applySmplMotionFps(rawFps);
    }
  };

  private readonly onMotionFpsChange = (): void => {
    this.syncMotionFpsInput();
  };

  constructor() {
    this.appRoot = requireElement<HTMLDivElement>('app');
    const canvas = requireElement<HTMLCanvasElement>('viewer-canvas');
    this.dropHint = requireElement<HTMLParagraphElement>('drop-hint');
    this.dropOverlayDockButton = requireElement<HTMLButtonElement>('drop-overlay-dock-btn');
    this.stateChip = requireElement<HTMLSpanElement>('state-chip');
    this.statusTitle = requireElement<HTMLElement>('status-title');
    this.modelTitle = requireElement<HTMLParagraphElement>('model-title');
    this.statusDetail = requireElement<HTMLParagraphElement>('status-detail');
    this.statusWarnings = requireElement<HTMLUListElement>('status-warnings');
    this.motionWarningsList = requireElement<HTMLUListElement>('motion-warnings');
    this.urdfSelect = requireElement<HTMLSelectElement>('urdf-select');
    this.smplModelSelect = requireElement<HTMLSelectElement>('smpl-model-select');
    this.urdfVisualControls = requireElement<HTMLDivElement>('urdf-visual-controls');
    this.showVisualButton = requireElement<HTMLButtonElement>('show-visual-btn');
    this.showCollisionButton = requireElement<HTMLButtonElement>('show-collision-btn');
    this.viewModeButton = requireElement<HTMLButtonElement>('view-mode-btn');
    this.modePropsPanel = requireElement<HTMLElement>('mode-props-panel');
    this.modePropsList = requireElement<HTMLDivElement>('mode-props-list');
    this.motionControlsSection = requireElement<HTMLElement>('motion-controls-section');
    this.motionPlayButton = requireElement<HTMLButtonElement>('motion-play-btn');
    this.motionResetButton = requireElement<HTMLButtonElement>('motion-reset-btn');
    this.motionFpsControl = requireElement<HTMLDivElement>('motion-fps-control');
    this.motionFpsInput = requireElement<HTMLInputElement>('motion-fps-input');
    this.motionFrameSlider = requireElement<HTMLInputElement>('motion-frame-slider');
    this.motionTitle = requireElement<HTMLParagraphElement>('motion-title');
    this.motionFrameLabel = requireElement<HTMLSpanElement>('motion-frame-label');
    this.folderInput = requireElement<HTMLInputElement>('folder-input');
    this.fileInput = requireElement<HTMLInputElement>('file-input');
    this.pickFolderButton = requireElement<HTMLButtonElement>('pick-folder-btn');
    this.pickFilesButton = requireElement<HTMLButtonElement>('pick-files-btn');
    this.resetButton = requireElement<HTMLButtonElement>('reset-btn');
    this.presetSelect = requireElement<HTMLSelectElement>('preset-select');
    this.presetLoadButton = requireElement<HTMLButtonElement>('preset-load-btn');
    this.objSelect = requireElement<HTMLSelectElement>('obj-select');
    this.exportMotionButton = requireElement<HTMLButtonElement>('export-motion-btn');
    this.insertKeyframeButton = requireElement<HTMLButtonElement>('insert-keyframe-btn');
    this.prevKeyframeButton = requireElement<HTMLButtonElement>('prev-keyframe-btn');
    this.nextKeyframeButton = requireElement<HTMLButtonElement>('next-keyframe-btn');
    this.motionFrameCountInput = requireElement<HTMLInputElement>('motion-frame-count-input');
    this.datasetPanel = requireElement<HTMLElement>('dataset-panel');
    this.datasetPanelMinimizeBtn = requireElement<HTMLButtonElement>('dataset-panel-minimize');
    this.statusPanel = requireElement<HTMLElement>('status-panel');
    this.statusPanelMinimizeBtn = requireElement<HTMLButtonElement>('status-panel-minimize');
    this.jointPanel = requireElement<HTMLElement>('joint-panel');
    this.jointPanelToggle = requireElement<HTMLButtonElement>('joint-panel-toggle');
    this.jointPanelContent = requireElement<HTMLDivElement>('joint-panel-content');
    this.jointList = requireElement<HTMLDivElement>('joint-list');

    this.sceneController = new SceneController(canvas);
    this.sceneController.setModelUpAxis('+Z');
    this.sceneController.setVisualProfile('default');
    this.sceneController.setViewMode(this.viewMode);
    this.sceneController.onViewWarning = (warning) => {
      this.sceneWarning = warning;
      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };

    this.urdfLoadService = new UrdfLoadService();
    this.csvMotionService = new CsvMotionService();
    this.mimicKitMotionService = new MimicKitMotionService();
    this.gmrMotionService = new GmrMotionService();
    this.bvhMotionService = new BvhMotionService();
    this.smplMotionService = new SmplMotionService();
    this.objLoadService = new ObjLoadService();
    this.motionPlayer = new G1MotionPlayer();
    this.bvhMotionPlayer = new BvhMotionPlayer();
    this.smplMotionPlayer = new SmplMotionPlayer();
    this.motionPlayer.onFrameChanged = (snapshot) => {
      this.motionFrameSnapshot = snapshot;
      this.syncMotionControls();
      this.sceneController.syncViewToCurrentRobot();
    };
    this.motionPlayer.onPlaybackStateChanged = (isPlaying) => {
      this.isMotionPlaying = isPlaying;
      this.syncMotionControls();
      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };
    this.motionPlayer.onWarning = (warning) => {
      if (!this.motionWarnings.includes(warning)) {
        this.motionWarnings.push(warning);
      }

      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };
    this.motionPlayer.onJointAnglesChanged = (jointNames, jointValues) => {
      this.updateJointPanelValues(jointNames, jointValues);
    };
    this.bvhMotionPlayer.onFrameChanged = (snapshot) => {
      this.motionFrameSnapshot = snapshot;
      this.syncMotionControls();
      this.sceneController.syncViewToCurrentRobot();
    };
    this.bvhMotionPlayer.onPlaybackStateChanged = (isPlaying) => {
      this.isMotionPlaying = isPlaying;
      this.syncMotionControls();
      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };
    this.bvhMotionPlayer.onWarning = (warning) => {
      if (!this.motionWarnings.includes(warning)) {
        this.motionWarnings.push(warning);
      }

      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };
    this.smplMotionPlayer.onFrameChanged = (snapshot) => {
      this.motionFrameSnapshot = snapshot;
      this.syncMotionControls();
      this.sceneController.syncViewToCurrentRobot();
    };
    this.smplMotionPlayer.onPlaybackStateChanged = (isPlaying) => {
      this.isMotionPlaying = isPlaying;
      this.syncMotionControls();
      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };
    this.smplMotionPlayer.onWarning = (warning) => {
      if (!this.motionWarnings.includes(warning)) {
        this.motionWarnings.push(warning);
      }

      if (this.isModelActiveState()) {
        this.renderCurrentReadyState();
      }
    };

    this.removeDropHandlers = registerDropHandlers(document, {
      onDrop: (dataTransfer) => this.handleDrop(dataTransfer),
      onDragStateChange: (isDragging) => this.handleDragStateChange(isDragging),
    });

    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('keydown', this.onWindowKeyDown);
    this.folderInput.addEventListener('change', this.onFolderInputChange);
    this.fileInput.addEventListener('change', this.onFileInputChange);
    this.pickFolderButton.addEventListener('click', this.onPickFolderClick);
    this.pickFilesButton.addEventListener('click', this.onPickFilesClick);
    this.resetButton.addEventListener('click', this.onResetClick);
    this.dropOverlayDockButton.addEventListener('click', this.onDropOverlayDockClick);
    this.presetSelect.addEventListener('change', this.onPresetSelectChange);
    this.presetLoadButton.addEventListener('click', this.onPresetLoadClick);
    this.objSelect.addEventListener('change', this.onObjSelectChange);
    this.showVisualButton.addEventListener('click', this.onShowVisualClick);
    this.showCollisionButton.addEventListener('click', this.onShowCollisionClick);
    this.viewModeButton.addEventListener('click', this.onViewModeClick);
    this.urdfSelect.addEventListener('change', this.onUrdfSelectChange);
    this.smplModelSelect.addEventListener('change', this.onSmplModelSelectChange);
    this.motionPlayButton.addEventListener('click', this.onMotionPlayClick);
    this.motionResetButton.addEventListener('click', this.onMotionResetClick);
    this.motionFpsInput.addEventListener('input', this.onMotionFpsInput);
    this.motionFpsInput.addEventListener('change', this.onMotionFpsChange);
    this.motionFrameSlider.addEventListener('input', this.onMotionFrameInput);
    this.exportMotionButton.addEventListener('click', this.onExportMotionClick);
    this.insertKeyframeButton.addEventListener('click', this.onInsertKeyframeClick);
    this.prevKeyframeButton.addEventListener('click', this.onPrevKeyframeClick);
    this.nextKeyframeButton.addEventListener('click', this.onNextKeyframeClick);
    this.motionFrameCountInput.addEventListener('change', this.onMotionFrameCountChange);
    this.jointPanelToggle.addEventListener('click', this.onJointPanelToggleClick);
    this.datasetPanelMinimizeBtn.addEventListener('click', this.onDatasetPanelMinimizeClick);
    this.statusPanelMinimizeBtn.addEventListener('click', this.onStatusPanelMinimizeClick);

    this.syncVisibilityButtons();
    this.syncMotionControls();
    this.syncPresetControls();
    this.syncObjControls();
    this.renderUrdfList();
    this.renderSmplModelList();
    this.renderState();
    void this.initializePresetManifest();
  }

  async handleDrop(dataTransfer: DataTransfer): Promise<void> {
    try {
      const fileMap = await dataTransferToFileMap(dataTransfer);
      await this.handleDroppedFileMap(fileMap);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Drop Failed',
        detail: reason,
      });
    }
  }

  resetViewer(): void {
    this.isDropOverlayDocked = false;
    this.syncDropOverlayDockState();
    this.droppedFileMap = null;
    this.availableUrdfPaths = this.getMergedUrdfModelPaths();
    this.selectedUrdfPath = null;
    this.selectedModelOptionKey = null;
    this.selectedMotionOptionKey = null;
    this.selectedCapturedObjPath = null;
    this.lastLoadResult = null;
    this.sceneWarning = null;
    this.recoverableDropHint = null;
    this.urdfLoadService.dispose();
    this.sceneController.setModelUpAxis('+Z');
    this.sceneController.setVisualProfile('default');
    this.sceneController.clearRobot();
    this.sceneController.resetView();
    this.motionPlayer.attachRobot(null);
    this.clearMotionPlayback();
    this.clearCurrentObjState();
    this.renderUrdfList();
    this.renderPresetOptions();
    this.renderSmplModelList();
    this.renderObjOptions();
    this.setState('idle');
  }

  dispose(): void {
    this.clearRecoverReadyTimer();
    this.removeDropHandlers();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('keydown', this.onWindowKeyDown);
    this.folderInput.removeEventListener('change', this.onFolderInputChange);
    this.fileInput.removeEventListener('change', this.onFileInputChange);
    this.pickFolderButton.removeEventListener('click', this.onPickFolderClick);
    this.pickFilesButton.removeEventListener('click', this.onPickFilesClick);
    this.resetButton.removeEventListener('click', this.onResetClick);
    this.dropOverlayDockButton.removeEventListener('click', this.onDropOverlayDockClick);
    this.presetSelect.removeEventListener('change', this.onPresetSelectChange);
    this.presetLoadButton.removeEventListener('click', this.onPresetLoadClick);
    this.objSelect.removeEventListener('change', this.onObjSelectChange);
    this.showVisualButton.removeEventListener('click', this.onShowVisualClick);
    this.showCollisionButton.removeEventListener('click', this.onShowCollisionClick);
    this.viewModeButton.removeEventListener('click', this.onViewModeClick);
    this.urdfSelect.removeEventListener('change', this.onUrdfSelectChange);
    this.smplModelSelect.removeEventListener('change', this.onSmplModelSelectChange);
    this.motionPlayButton.removeEventListener('click', this.onMotionPlayClick);
    this.motionResetButton.removeEventListener('click', this.onMotionResetClick);
    this.motionFpsInput.removeEventListener('input', this.onMotionFpsInput);
    this.motionFpsInput.removeEventListener('change', this.onMotionFpsChange);
    this.motionFrameSlider.removeEventListener('input', this.onMotionFrameInput);

    this.urdfLoadService.dispose();
    this.motionPlayer.dispose();
    this.bvhMotionPlayer.dispose();
    this.smplMotionPlayer.dispose();
    this.sceneController.dispose();
  }

  private async handlePickedFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const fileMap = fileListToFileMap(Array.from(fileList));
    await this.handleDroppedFileMap(fileMap);
  }

  private async handleDroppedFileMap(fileMap: DroppedFileMap): Promise<void> {
    if (fileMap.size === 0) {
      this.setState('error', {
        title: 'No Files Found',
        detail: 'Drop payload did not contain files. Try selecting a folder or file set again.',
      });
      return;
    }

    const urdfPaths = this.urdfLoadService.getAvailableUrdfPaths(fileMap);
    if (urdfPaths.length > 0) {
      this.registerDroppedUrdfFiles(fileMap);
      this.availableUrdfPaths = this.getMergedUrdfModelPaths();
      this.selectedUrdfPath = urdfPaths[0] ?? null;
      this.renderUrdfList();

      if (!this.selectedUrdfPath) {
        this.setState('error', {
          title: 'No URDF Found',
          detail: 'Dropped files do not contain .urdf models.',
        });
        return;
      }

      await this.loadSelectedUrdf(this.selectedUrdfPath);
      return;
    }

    const csvPaths = this.csvMotionService.getAvailableCsvPaths(fileMap);
    if (csvPaths.length > 0) {
      await this.loadMotionFromDroppedFiles(fileMap);
      return;
    }

    const bvhPaths = this.bvhMotionService.getAvailableBvhPaths(fileMap);
    if (bvhPaths.length > 0) {
      await this.loadBvhMotionFromDroppedFiles(fileMap);
      return;
    }

    // Try to load as either MimicKit or GMR PKL
    const mimicKitPklPaths = [...this.mimicKitMotionService.getAvailablePklPaths(fileMap)];
    if (mimicKitPklPaths.length > 0) {
      const loadedRobotResult = this.lastLoadResult;
      if (!loadedRobotResult) {
        this.showRecoverableDropError(
          'URDF Required For Motion',
          'Load a URDF robot first, then drop motion PKL.',
          'Motion-only drop needs an active URDF robot.',
        );
        return;
      }

      // 尝试所有.pkl文件，先尝试MimicKit，再尝试GMR
      for (const path of mimicKitPklPaths) {
        try {
          this.setState('loading', {
            detail: 'Loading MimicKit motion PKL ...',
          });
          const result = await this.mimicKitMotionService.loadFromDroppedFiles(
            fileMap,
            loadedRobotResult.motionSchema,
            path,
          );
          this.applyLoadedUrdfMotion(
            loadedRobotResult,
            result.clip,
            'mimickit',
            result.selectedMotionPath,
            result.warnings,
          );
          return;
        } catch (mimicKitError) {
          console.log(`Failed to load ${path} as MimicKit, trying GMR:`, mimicKitError);
          try {
            this.setState('loading', {
              detail: 'Loading GMR motion PKL ...',
            });
            const result = await this.gmrMotionService.loadFromDroppedFiles(
              fileMap,
              loadedRobotResult.motionSchema,
              path,
            );
            this.applyLoadedUrdfMotion(
              loadedRobotResult,
              result.clip,
              'gmr',
              result.selectedMotionPath,
              result.warnings,
            );
            return;
          } catch (gmrError) {
            console.log(`Failed to load ${path} as GMR either:`, gmrError);
            // 继续尝试下一个文件
          }
        }
      }

      // 所有文件都尝试失败
      this.setState('error', {
        title: 'Motion Load Failed',
        detail: 'Failed to load any .pkl file as either MimicKit or GMR format.',
      });
    }

    const smplScan = await this.smplMotionService.scanDroppedNpzFiles(fileMap);
    if (smplScan.modelPaths.length > 0 || smplScan.motionPaths.length > 0) {
      if (smplScan.modelPaths.length > 0) {
        this.registerDroppedSmplModels(fileMap, smplScan.modelPaths);
      }

      if (smplScan.modelPaths.length > 0 && smplScan.motionPaths.length > 0) {
        await this.loadSmplMotionFromDroppedFiles(fileMap);
        return;
      }

      if (smplScan.modelPaths.length > 0) {
        await this.loadSmplModelFromDroppedFiles(fileMap);
        return;
      }

      if (this.currentSmplFileMap && this.currentSmplModel) {
        const preferredDroppedMotionPath = smplScan.motionPaths[0];
        const mergedSmplFileMap = this.smplMotionService.mergeDroppedFileMaps(
          this.currentSmplFileMap,
          fileMap,
        );
        await this.loadSmplMotionFromDroppedFiles(
          mergedSmplFileMap,
          undefined,
          preferredDroppedMotionPath,
        );
        return;
      }

      this.showRecoverableDropError(
        'SMPL Model Required',
        'Load a SMPL model file first (NPZ or smpl_webuser basicmodel PKL), then drop SMPL motion NPZ.',
        'SMPL motion-only drop needs an active SMPL model.',
      );
      return;
    }

    const objPaths = this.objLoadService.getAvailableObjPaths(fileMap);
    if (objPaths.length > 0) {
      const importResult = this.registerDroppedCapturedObjs(fileMap);
      const hasSmplContext = Boolean(
        this.currentSmplModel || this.currentSmplMotion || this.currentSmplFileMap,
      );
      if (hasSmplContext) {
        const importedCount = importResult.addedCount + importResult.updatedCount;
        if (importedCount > 0) {
          const summary = `Imported ${importedCount} OBJ file${importedCount > 1 ? 's' : ''} into Captured OBJ catalog.`;
          if (!this.motionWarnings.includes(summary)) {
            this.motionWarnings.push(summary);
          }
        }
        if (this.isModelActiveState()) {
          this.renderCurrentReadyState();
        }
        return;
      }
      await this.loadObjModelFromDroppedFiles(fileMap);
      return;
    }

    this.showRecoverableDropError(
      'No Supported Files',
      '',
      'Unsupported files were ignored.\n Check https://github.com/Renkunzhao/motion_viewer#Usage for supported formats.',
    );
  }

  private async loadSelectedUrdf(urdfPath: string): Promise<void> {
    const normalizedUrdfPath = normalizePath(urdfPath);
    if (!normalizedUrdfPath) {
      this.setState('error', {
        title: 'Load Failed',
        detail: `Invalid URDF path: ${urdfPath}`,
      });
      return;
    }

    this.lastLoadResult = null;
    this.sceneWarning = null;
    this.sceneController.setModelUpAxis('+Z');
    this.sceneController.setVisualProfile('default');
    this.selectedUrdfPath = normalizedUrdfPath;
    this.selectedModelOptionKey = `urdf:${normalizedUrdfPath}`;
    this.selectedMotionOptionKey = null;
    this.renderUrdfList();
    this.sceneController.clearRobot();
    this.clearMotionPlayback();
    this.clearCurrentObjState();
    this.setState('loading', {
      detail: `Loading ${normalizedUrdfPath} ...`,
    });

    try {
      const hasLocalUrdf = this.droppedUrdfFileMap.has(normalizedUrdfPath);
      const sourceFileMap =
        hasLocalUrdf
          ? this.droppedUrdfFileMap
          : this.droppedFileMap && this.droppedFileMap.has(normalizedUrdfPath)
            ? this.droppedFileMap
            : null;
      const result = sourceFileMap
        ? await this.urdfLoadService.loadFromDroppedFiles(sourceFileMap, normalizedUrdfPath)
        : await this.urdfLoadService.loadFromPresetUrl(normalizedUrdfPath);
      this.sceneController.setRobot(result.robot);
      this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);
      this.motionPlayer.attachRobot(result.robot);
      this.lastLoadResult = result;
      this.selectedUrdfPath = result.selectedUrdfPath;
      this.selectedModelOptionKey = `urdf:${result.selectedUrdfPath}`;
      this.recoverableDropHint = null;
      this.renderUrdfList();
      this.renderReadyState(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Load Failed',
        detail: reason,
      });
    }
  }

  private async loadSelectedSmplModel(smplModelPath: string): Promise<void> {
    const normalizedModelPath = normalizePath(smplModelPath);
    if (!normalizedModelPath) {
      this.setState('error', {
        title: 'SMPL Load Failed',
        detail: `Invalid SMPL model path: ${smplModelPath}`,
      });
      return;
    }

    try {
      const selectedModelFileMap = await this.resolveSmplModelFileMap(normalizedModelPath);
      if (this.currentMotionKind === 'smpl' && this.currentSmplMotion) {
        const mergedFileMap = this.currentSmplFileMap
          ? this.smplMotionService.mergeDroppedFileMaps(this.currentSmplFileMap, selectedModelFileMap)
          : selectedModelFileMap;
        await this.loadSmplMotionFromDroppedFiles(
          mergedFileMap,
          normalizedModelPath,
          this.currentSmplMotion.motionSourcePath,
        );
        return;
      }

      const mergedFileMap = this.currentSmplFileMap
        ? this.smplMotionService.mergeDroppedFileMaps(this.currentSmplFileMap, selectedModelFileMap)
        : selectedModelFileMap;
      await this.loadSmplModelFromDroppedFiles(mergedFileMap, normalizedModelPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'SMPL Load Failed',
        detail: reason,
      });
    }
  }

  private applyLoadedUrdfMotion(
    loadedRobotResult: LoadedRobotResult,
    clip: MotionClip,
    motionKind: UrdfMotionKind,
    sourcePath: string,
    warnings: string[],
  ): void {
    this.bvhMotionPlayer.load(null, null);
    this.motionPlayer.attachRobot(loadedRobotResult.robot);
    const bindingReport = this.motionPlayer.loadClip(clip);
    this.sceneController.syncGroundToCurrentRobot();

    this.currentMotionClip = clip;
    this.currentBvhMotion = null;
    this.currentBvhFileMap = null;
    this.currentMotionKind = motionKind;
    this.currentMotionSourcePath = sourcePath;
    this.motionWarnings = [...warnings];
    if (bindingReport.missingRootJoint) {
      this.motionWarnings.push(
        `Joint "${clip.schema.rootJointName}" was not found. Root translation/rotation is ignored.`,
      );
    }

    this.motionFrameSnapshot = {
      frameIndex: 0,
      frameCount: clip.frameCount,
      fps: clip.fps,
      timeSeconds: 0,
    };
    this.playActiveMotion();
    this.syncMotionControls();
    this.recoverableDropHint = null;
    this.showJointPanel();
    this.renderReadyState(loadedRobotResult);
  }

  private async loadMotionFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredCsvPath?: string,
  ): Promise<void> {
    const loadedRobotResult = this.lastLoadResult;
    if (!loadedRobotResult) {
      this.showRecoverableDropError(
        'URDF Required For CSV',
        'Load a URDF robot first, then drop CSV motion.',
        'CSV needs an active URDF robot. Drop URDF first, then CSV.',
      );
      return;
    }

    this.setState('loading', {
      detail: 'Loading motion CSV ...',
    });

    try {
      const result = await this.csvMotionService.loadFromDroppedFiles(
        fileMap,
        loadedRobotResult.motionSchema,
        preferredCsvPath,
      );
      this.applyLoadedUrdfMotion(
        loadedRobotResult,
        result.clip,
        'csv',
        result.selectedCsvPath,
        result.warnings,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Motion Load Failed',
        detail: reason,
      });
    }
  }

  private async loadMimicKitMotionFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredMotionPath?: string,
  ): Promise<void> {
    const loadedRobotResult = this.lastLoadResult;
    if (!loadedRobotResult) {
      this.showRecoverableDropError(
        'URDF Required For MimicKit',
        'Load a URDF robot first, then drop MimicKit motion PKL.',
        'MimicKit motion-only drop needs an active URDF robot.',
      );
      return;
    }

    this.setState('loading', {
      detail: 'Loading MimicKit motion PKL ...',
    });

    try {
      const result = await this.mimicKitMotionService.loadFromDroppedFiles(
        fileMap,
        loadedRobotResult.motionSchema,
        preferredMotionPath,
      );
      this.applyLoadedUrdfMotion(
        loadedRobotResult,
        result.clip,
        'mimickit',
        result.selectedMotionPath,
        result.warnings,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Motion Load Failed',
        detail: reason,
      });
    }
  }

  private async loadGmrMotionFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredMotionPath?: string,
  ): Promise<void> {
    const loadedRobotResult = this.lastLoadResult;
    if (!loadedRobotResult) {
      this.showRecoverableDropError(
        'URDF Required For GMR',
        'Load a URDF robot first, then drop GMR motion PKL.',
        'GMR motion-only drop needs an active URDF robot. Drop URDF first, then GMR PKL.',
      );
      return;
    }

    this.setState('loading', {
      detail: 'Loading GMR motion PKL ...',
    });

    try {
      const result = await this.gmrMotionService.loadFromDroppedFiles(
        fileMap,
        loadedRobotResult.motionSchema,
        preferredMotionPath,
      );
      this.applyLoadedUrdfMotion(
        loadedRobotResult,
        result.clip,
        'gmr',
        result.selectedMotionPath,
        result.warnings,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Motion Load Failed',
        detail: reason,
      });
    }
  }

  private async loadBvhMotionFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredBvhPath?: string,
    linearUnit: BvhLinearUnit = this.bvhLinearUnit,
  ): Promise<void> {
    this.setState('loading', {
      detail: 'Loading motion BVH ...',
    });

    try {
      const result = await this.bvhMotionService.loadFromDroppedFiles(
        fileMap,
        preferredBvhPath,
        linearUnit,
      );

      this.lastLoadResult = null;
      this.sceneWarning = null;
      this.droppedFileMap = null;
      this.availableUrdfPaths = this.getMergedUrdfModelPaths();
      this.selectedUrdfPath = null;
      this.selectedModelOptionKey = null;
      this.selectedMotionOptionKey = null;
      this.urdfLoadService.dispose();
      this.renderUrdfList();
      this.renderPresetOptions();

      this.sceneController.clearRobot();
      this.sceneController.setModelUpAxis('+Y');
      this.sceneController.setVisualProfile('default');
      this.clearMotionPlayback();
      this.clearCurrentObjState();
      this.sceneController.setRobot(result.sceneObject as unknown as LoadedRobotResult['robot']);
      this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);

      this.currentMotionClip = null;
      this.currentBvhMotion = {
        name: result.clip.name,
        sourcePath: result.selectedBvhPath,
        frameCount: result.frameCount,
        fps: result.fps,
        jointCount: result.jointCount,
        linearUnit: result.linearUnit,
      };
      this.currentBvhFileMap = fileMap;
      this.bvhLinearUnit = result.linearUnit;
      this.selectedModelOptionKey = BVH_PREVIEW_MODEL_KEY;
      this.currentMotionKind = 'bvh';
      this.currentMotionSourcePath = result.selectedBvhPath;
      this.motionWarnings = [...result.warnings];
      this.motionFrameSnapshot = {
        frameIndex: 0,
        frameCount: result.frameCount,
        fps: result.fps,
        timeSeconds: 0,
      };

      this.bvhMotionPlayer.load(result.playbackTarget, result.clip);
      this.sceneController.frameRobot();
      this.sceneController.syncGroundToCurrentRobot();
      this.playActiveMotion();
      this.syncMotionControls();
      this.recoverableDropHint = null;
      this.renderBvhReadyState();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Motion Load Failed',
        detail: reason,
      });
    }
  }

  private async loadSmplMotionFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredModelPath?: string,
    preferredMotionPath?: string,
  ): Promise<void> {
    this.setState('loading', {
      detail: 'Loading SMPL model and motion ...',
    });

    try {
      const result = await this.smplMotionService.loadFromDroppedFiles(
        fileMap,
        preferredModelPath,
        preferredMotionPath,
      );
      const hadActiveObj = Boolean(this.currentObjModel);
      let objectResult: ObjModelLoadResult | null = null;
      const objectWarnings: string[] = [];
      if (result.hasObjectMotion) {
        const objectLoad = await this.resolveObjForSmplScene(fileMap, result.objectName);
        objectResult = objectLoad.result;
        objectWarnings.push(...objectLoad.warnings);
        if (!objectResult) {
          this.clearCurrentObjState();
          const missingObjectWarning = formatMissingObjectModelWarning(result.objectName);
          if (hadActiveObj && !objectWarnings.includes(missingObjectWarning)) {
            objectWarnings.push(missingObjectWarning);
          }
        }
      } else {
        this.clearCurrentObjState();
        if (hadActiveObj) {
          objectWarnings.push('SMPL motion has no object track; cleared active OBJ from scene.');
        }
      }
      if (objectResult) {
        this.attachObjToSmplScene(
          result.sceneObject,
          result.playbackTarget,
          objectResult,
          result.hasObjectMotion,
        );
      }

      this.lastLoadResult = null;
      this.sceneWarning = null;
      this.droppedFileMap = null;
      this.availableUrdfPaths = this.getMergedUrdfModelPaths();
      this.selectedUrdfPath = null;
      this.urdfLoadService.dispose();
      this.renderUrdfList();

      this.sceneController.clearRobot();
      this.sceneController.setModelUpAxis('+Z');
      this.sceneController.setVisualProfile('smpl');
      this.clearMotionPlayback();
      this.sceneController.setRobot(result.sceneObject as unknown as LoadedRobotResult['robot']);
      this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);
      this.bindSmplDisplayNodes(result.sceneObject);

      this.currentMotionClip = null;
      this.currentBvhMotion = null;
      this.currentBvhFileMap = null;
      this.currentSmplModel = {
        modelName: result.modelName,
        modelSourcePath: result.selectedModelPath,
        modelGender: result.modelGender,
        jointCount: result.jointCount,
        vertexCount: result.vertexCount,
      };
      this.currentSmplMotion = {
        modelName: result.modelName,
        modelSourcePath: result.selectedModelPath,
        motionName: result.motionName,
        motionSourcePath: result.selectedMotionPath,
        frameCount: result.frameCount,
        fps: result.fps,
        jointCount: result.jointCount,
        vertexCount: result.vertexCount,
        motionGender: result.motionGender,
        modelGender: result.modelGender,
        hasObjectMotion: result.hasObjectMotion,
        objectName: result.objectName,
      };
      this.currentSmplFileMap = fileMap;
      this.availableSmplModelPaths = mergeUniquePaths(
        this.getMergedSmplModelPaths(),
        result.availableModelPaths,
      );
      this.selectedSmplModelPath = result.selectedModelPath;
      this.selectedModelOptionKey = `smpl:${result.selectedModelPath}`;
      this.renderSmplModelList();
      this.renderUrdfList();
      this.currentMotionKind = 'smpl';
      this.currentMotionSourcePath = result.selectedMotionPath;
      this.motionWarnings = [...result.warnings, ...objectWarnings];
      this.motionFrameSnapshot = {
        frameIndex: 0,
        frameCount: result.frameCount,
        fps: result.fps,
        timeSeconds: 0,
      };

      this.smplMotionPlayer.load(result.playbackTarget, result.clip);
      this.sceneController.frameRobot();
      this.sceneController.syncGroundToCurrentRobot();
      this.playActiveMotion();
      this.syncMotionControls();
      this.recoverableDropHint = null;
      this.renderSmplReadyState();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'SMPL Load Failed',
        detail: reason,
      });
    }
  }

  private async loadSmplModelFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredModelPath?: string,
  ): Promise<void> {
    this.setState('loading', {
      detail: 'Loading SMPL model ...',
    });

    try {
      const result = await this.smplMotionService.loadModelOnlyFromDroppedFiles(
        fileMap,
        preferredModelPath,
      );
      const hadActiveObj = Boolean(this.currentObjModel);
      this.clearCurrentObjState();

      this.lastLoadResult = null;
      this.sceneWarning = null;
      this.droppedFileMap = null;
      this.availableUrdfPaths = this.getMergedUrdfModelPaths();
      this.selectedUrdfPath = null;
      this.urdfLoadService.dispose();
      this.renderUrdfList();

      this.sceneController.clearRobot();
      this.sceneController.setModelUpAxis('+Y');
      this.sceneController.setVisualProfile('smpl');
      this.clearMotionPlayback();
      this.sceneController.setRobot(result.sceneObject as unknown as LoadedRobotResult['robot']);
      this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);
      this.bindSmplDisplayNodes(result.sceneObject);

      this.currentMotionClip = null;
      this.currentBvhMotion = null;
      this.currentBvhFileMap = null;
      this.currentSmplModel = {
        modelName: result.modelName,
        modelSourcePath: result.selectedModelPath,
        modelGender: result.modelGender,
        jointCount: result.jointCount,
        vertexCount: result.vertexCount,
      };
      this.currentSmplMotion = null;
      this.currentSmplFileMap = fileMap;
      this.availableSmplModelPaths = mergeUniquePaths(
        this.getMergedSmplModelPaths(),
        result.availableModelPaths,
      );
      this.selectedSmplModelPath = result.selectedModelPath;
      this.selectedModelOptionKey = `smpl:${result.selectedModelPath}`;
      this.renderSmplModelList();
      this.renderUrdfList();
      this.currentMotionKind = null;
      this.currentMotionSourcePath = null;
      this.motionWarnings = hadActiveObj
        ? [...result.warnings, 'Loaded SMPL model; cleared active OBJ from scene.']
        : [...result.warnings];
      this.motionFrameSnapshot = null;
      this.isMotionPlaying = false;

      this.sceneController.frameRobot();
      this.sceneController.syncGroundToCurrentRobot();
      this.syncMotionControls();
      this.recoverableDropHint = null;
      this.renderSmplModelReadyState();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'SMPL Load Failed',
        detail: reason,
      });
    }
  }

  private async loadObjModelFromDroppedFiles(
    fileMap: DroppedFileMap,
    preferredObjPath?: string,
  ): Promise<void> {
    this.setState('loading', {
      detail: 'Loading OBJ model ...',
    });

    try {
      const hadActiveSmpl = Boolean(this.currentSmplModel || this.currentSmplMotion);
      const result = await this.objLoadService.loadFromDroppedFiles(fileMap, preferredObjPath);
      this.setCurrentObjState(fileMap, result);

      this.lastLoadResult = null;
      this.sceneWarning = null;
      this.droppedFileMap = null;
      this.availableUrdfPaths = this.getMergedUrdfModelPaths();
      this.selectedUrdfPath = null;
      this.urdfLoadService.dispose();
      this.renderUrdfList();

      this.sceneController.clearRobot();
      this.sceneController.setModelUpAxis('+Z');
      this.sceneController.setVisualProfile('default');
      this.clearMotionPlayback();
      this.sceneController.setRobot(result.sceneObject as unknown as LoadedRobotResult['robot']);
      this.sceneController.setGeometryVisibility(this.showVisual, this.showCollision);
      this.sceneController.frameRobot();
      this.sceneController.syncGroundToCurrentRobot();
      this.syncMotionControls();
      this.recoverableDropHint = null;
      this.motionWarnings = hadActiveSmpl
        ? [...result.warnings, 'Loaded OBJ model; cleared active SMPL scene.']
        : [...result.warnings];
      this.renderObjReadyState();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'OBJ Load Failed',
        detail: reason,
      });
    }
  }

  private async resolveObjForSmplScene(
    fileMap: DroppedFileMap,
    motionObjectName?: string | null,
  ): Promise<{ result: ObjModelLoadResult | null; warnings: string[] }> {
    const warnings: string[] = [];
    const objPaths = this.objLoadService.getAvailableObjPaths(fileMap);
    if (objPaths.length > 0) {
      this.registerDroppedCapturedObjs(fileMap);
      const result = await this.objLoadService.loadFromDroppedFiles(fileMap, undefined, {
        normalizeToGround: false,
      });
      this.setCurrentObjState(fileMap, result);
      warnings.push(...result.warnings);
      return { result, warnings };
    }

    if (this.selectedCapturedObjPath) {
      const selectedLoad = await this.loadSelectedCapturedObjForSmplScene(this.selectedCapturedObjPath);
      warnings.push(...selectedLoad.warnings);
      if (selectedLoad.result) {
        return { result: selectedLoad.result, warnings };
      }
    }

    const desiredObjectName = normalizeObjectToken(motionObjectName ?? '');
    if (!desiredObjectName) {
      return { result: null, warnings };
    }

    const autoLoad = await this.loadCapturedObjForMotionObjectName(desiredObjectName);
    warnings.push(...autoLoad.warnings);
    return { result: autoLoad.result, warnings };
  }

  private async loadSelectedCapturedObjForSmplScene(
    objectPath: string,
  ): Promise<{ result: ObjModelLoadResult | null; warnings: string[] }> {
    const warnings: string[] = [];
    const normalizedPath = normalizePath(objectPath);
    if (!normalizedPath) {
      return { result: null, warnings };
    }

    const selectedObj = this.getCapturedObjCatalogEntries().find(
      (candidate) => candidate.mapAs === normalizedPath,
    );
    if (!selectedObj) {
      warnings.push(`Selected object "${objectPath}" is no longer available in the catalog.`);
      return { result: null, warnings };
    }

    try {
      const resolved = await this.resolveCapturedObjSource(selectedObj);
      const result = await this.objLoadService.loadFromDroppedFiles(
        resolved.fileMap,
        resolved.preferredObjPath,
        {
          normalizeToGround: false,
        },
      );
      this.setCurrentObjState(resolved.fileMap, result);
      warnings.push(...result.warnings);
      return { result, warnings };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to load selected object "${objectPath}": ${reason}`);
      return { result: null, warnings };
    }
  }

  private async loadCapturedObjForMotionObjectName(
    objectName: string,
  ): Promise<{ result: ObjModelLoadResult | null; warnings: string[] }> {
    const warnings: string[] = [];
    const candidates = this.findCapturedObjCandidatesForObjectName(objectName);
    if (candidates.length === 0) {
      warnings.push(formatMissingObjectModelWarning(objectName));
      return { result: null, warnings };
    }

    for (const matched of candidates) {
      try {
        const resolved = await this.resolveCapturedObjSource(matched);
        const result = await this.objLoadService.loadFromDroppedFiles(
          resolved.fileMap,
          resolved.preferredObjPath,
          {
            normalizeToGround: false,
          },
        );
        this.setCurrentObjState(resolved.fileMap, result);
        warnings.push(...result.warnings);
        return { result, warnings };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(
          `Failed to auto-load captured OBJ for object "${objectName}" (${matched.mapAs}): ${reason}`,
        );
      }
    }

    return { result: null, warnings };
  }

  private findCapturedObjCandidatesForObjectName(objectName: string): PresetAssetFile[] {
    const candidates: PresetAssetFile[] = [];
    for (const candidate of this.getCapturedObjCatalogEntries()) {
      const candidateName = parseCapturedObjNameFromPath(candidate.mapAs);
      if (!candidateName || candidateName !== objectName) {
        continue;
      }
      candidates.push(candidate);
    }

    candidates.sort((left, right) => {
      const leftIsLocal = this.droppedCapturedObjFileMap.has(left.mapAs);
      const rightIsLocal = this.droppedCapturedObjFileMap.has(right.mapAs);
      if (leftIsLocal !== rightIsLocal) {
        return leftIsLocal ? -1 : 1;
      }

      const scoreDelta = scoreCapturedObjPath(left.mapAs) - scoreCapturedObjPath(right.mapAs);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left.mapAs.localeCompare(right.mapAs);
    });

    return candidates;
  }

  private attachObjToSmplScene(
    smplSceneObject: any,
    playbackTarget: { objectRoot?: any },
    objResult: ObjModelLoadResult,
    hasObjectMotion: boolean,
  ): void {
    if (!hasObjectMotion) {
      this.placeObjectBesideSmplModel(smplSceneObject, objResult.motionRoot);
    }
    smplSceneObject.add(objResult.sceneObject);
    playbackTarget.objectRoot = objResult.motionRoot;
  }

  private placeObjectBesideSmplModel(smplSceneObject: any, objectRoot: any): void {
    smplSceneObject.updateMatrixWorld(true);
    objectRoot.updateMatrixWorld(true);

    const smplBounds = new Box3().setFromObject(smplSceneObject, true);
    const objectBounds = new Box3().setFromObject(objectRoot, true);
    if (smplBounds.isEmpty() || objectBounds.isEmpty()) {
      objectRoot.position.set(1.5, 0, 0);
      return;
    }

    const smplSize = smplBounds.getSize(new Vector3());
    const objectSize = objectBounds.getSize(new Vector3());
    const smplCenter = smplBounds.getCenter(new Vector3());
    const objectCenter = objectBounds.getCenter(new Vector3());
    const horizontalGap = Math.max(0.45, (smplSize.x + objectSize.x) * 0.12);
    const targetX = smplCenter.x + smplSize.x * 0.5 + objectSize.x * 0.5 + horizontalGap;
    const targetY = smplBounds.min.y;
    const targetZ = smplCenter.z;

    objectRoot.position.x += targetX - objectCenter.x;
    objectRoot.position.y += targetY - objectBounds.min.y;
    objectRoot.position.z += targetZ - objectCenter.z;
  }

  private clearCurrentObjState(): void {
    this.currentObjModel = null;
    this.currentObjFileMap = null;
    this.syncObjSelectionToCurrentModel();
  }

  private setCurrentObjState(fileMap: DroppedFileMap, result: ObjModelLoadResult): void {
    this.currentObjFileMap = fileMap;
    this.currentObjModel = {
      modelName: result.modelName,
      modelSourcePath: result.selectedObjPath,
      meshCount: result.meshCount,
    };
    this.syncObjSelectionToCurrentModel();
  }

  private syncObjSelectionToCurrentModel(): void {
    if (this.selectedCapturedObjPath !== null) {
      const selectedPath = normalizePath(this.selectedCapturedObjPath);
      if (
        selectedPath &&
        this.getCapturedObjCatalogEntries().some((candidate) => candidate.mapAs === selectedPath)
      ) {
        this.objSelect.value = selectedPath;
      } else {
        this.objSelect.value = '';
      }
      return;
    }

    const modelPath = normalizePath(this.currentObjModel?.modelSourcePath ?? '');
    if (
      modelPath &&
      this.getCapturedObjCatalogEntries().some((candidate) => candidate.mapAs === modelPath)
    ) {
      this.objSelect.value = modelPath;
      return;
    }

    this.objSelect.value = '';
  }

  private getMergedUrdfModelPaths(): string[] {
    const droppedUrdfPaths = this.urdfLoadService.getAvailableUrdfPaths(this.droppedUrdfFileMap);
    const presetUrdfPaths = this.presetUrdfCatalog.map((model) => model.mapAs);
    return mergeUniquePaths(presetUrdfPaths, droppedUrdfPaths);
  }

  private getMergedSmplModelPaths(): string[] {
    const droppedModelPaths = [...this.droppedSmplModelFileMap.keys()].filter((path) =>
      isSmplModelPath(path),
    );
    const presetModelPaths = this.presetSmplModelCatalog.map((model) => model.mapAs);
    return mergeUniquePaths(presetModelPaths, droppedModelPaths);
  }

  private getAvailableModelOptions(): SelectableModelOption[] {
    const options = new Map<string, SelectableModelOption>();

    for (const option of this.presetModelCatalog) {
      options.set(option.key, option);
    }

    for (const urdfPath of this.urdfLoadService.getAvailableUrdfPaths(this.droppedUrdfFileMap)) {
      const normalizedPath = normalizePath(urdfPath);
      if (!normalizedPath) {
        continue;
      }

      options.set(`urdf:${normalizedPath}`, {
        key: `urdf:${normalizedPath}`,
        label: formatSelectableModelLabel('urdf', normalizedPath),
        kind: 'urdf',
        path: normalizedPath,
        bindingTag: inferModelBindingTag('urdf', normalizedPath),
        source: 'dropped',
      });
    }

    for (const smplPath of [...this.droppedSmplModelFileMap.keys()]) {
      const normalizedPath = normalizePath(smplPath);
      if (!normalizedPath || !isSmplModelPath(normalizedPath)) {
        continue;
      }

      options.set(`smpl:${normalizedPath}`, {
        key: `smpl:${normalizedPath}`,
        label: formatSelectableModelLabel('smpl', normalizedPath),
        kind: 'smpl',
        path: normalizedPath,
        bindingTag: inferModelBindingTag('smpl', normalizedPath),
        source: 'dropped',
      });
    }

    if (
      (this.currentMotionKind === 'bvh' || this.presetMotionCatalog.some((option) => option.kind === 'bvh')) &&
      !options.has(BVH_PREVIEW_MODEL_KEY)
    ) {
      options.set(BVH_PREVIEW_MODEL_KEY, {
        key: BVH_PREVIEW_MODEL_KEY,
        label: 'BVH Preview',
        kind: 'bvh',
        path: BVH_PREVIEW_MODEL_KEY,
        bindingTag: 'bvh',
        source: 'builtin',
        description: 'Built-in BVH preview skeleton.',
      });
    }

    return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  private getCurrentModelOptionKey(options = this.getAvailableModelOptions()): string | null {
    if (this.selectedModelOptionKey && options.some((option) => option.key === this.selectedModelOptionKey)) {
      return this.selectedModelOptionKey;
    }

    const normalizedUrdfPath = normalizePath(this.selectedUrdfPath ?? '');
    if (normalizedUrdfPath) {
      const urdfKey = `urdf:${normalizedUrdfPath}`;
      if (options.some((option) => option.key === urdfKey)) {
        return urdfKey;
      }
    }

    const normalizedSmplPath = normalizePath(
      this.selectedSmplModelPath ??
        this.currentSmplMotion?.modelSourcePath ??
        this.currentSmplModel?.modelSourcePath ??
        '',
    );
    if (normalizedSmplPath) {
      const smplKey = `smpl:${normalizedSmplPath}`;
      if (options.some((option) => option.key === smplKey)) {
        return smplKey;
      }
    }

    if (
      this.currentMotionKind === 'bvh' &&
      options.some((option) => option.key === BVH_PREVIEW_MODEL_KEY)
    ) {
      return BVH_PREVIEW_MODEL_KEY;
    }

    return null;
  }

  private getCurrentModelOption(): SelectableModelOption | null {
    const options = this.getAvailableModelOptions();
    const currentKey = this.getCurrentModelOptionKey(options);
    return options.find((option) => option.key === currentKey) ?? null;
  }

  private isMotionCompatibleWithModel(
    motionOption: SelectableMotionOption,
    modelOption: SelectableModelOption,
  ): boolean {
    if (modelOption.kind === 'bvh') {
      return motionOption.kind === 'bvh';
    }

    if (modelOption.kind === 'smpl') {
      if (motionOption.kind !== 'smpl' || !modelOption.bindingTag) {
        return false;
      }
      return motionOption.bindingTags.includes(modelOption.bindingTag);
    }

    if ((motionOption.kind !== 'csv' && motionOption.kind !== 'mimickit') || !modelOption.bindingTag) {
      return false;
    }

    return motionOption.bindingTags.includes(modelOption.bindingTag);
  }

  private getCompatibleMotionOptions(
    modelOption: SelectableModelOption | null = this.getCurrentModelOption(),
  ): SelectableMotionOption[] {
    if (!modelOption) {
      return [];
    }

    return this.presetMotionCatalog.filter((option) =>
      this.isMotionCompatibleWithModel(option, modelOption),
    );
  }

  private getCurrentMotionOptionKey(
    motionOptions = this.getCompatibleMotionOptions(),
  ): string | null {
    if (
      this.selectedMotionOptionKey &&
      motionOptions.some((option) => option.key === this.selectedMotionOptionKey)
    ) {
      return this.selectedMotionOptionKey;
    }

    const normalizedMotionPath = normalizePath(this.currentMotionSourcePath ?? '');
    if (!normalizedMotionPath || !this.currentMotionKind) {
      return null;
    }

    const motionKey = `${this.currentMotionKind}:${normalizedMotionPath}`;
    return motionOptions.some((option) => option.key === motionKey) ? motionKey : null;
  }

  private async loadModelOptionByKey(modelKey: string): Promise<void> {
    const modelOption =
      this.getAvailableModelOptions().find((option) => option.key === modelKey) ?? null;
    if (!modelOption) {
      this.setState('error', {
        title: 'Model Not Found',
        detail: `Model "${modelKey}" is not available.`,
      });
      return;
    }

    if (this.isPresetLoading) {
      return;
    }

    this.selectedModelOptionKey = modelOption.key;
    this.selectedMotionOptionKey = null;
    this.renderUrdfList();
    this.renderPresetOptions();
    this.renderObjOptions();

    if (modelOption.kind === 'bvh') {
      this.lastLoadResult = null;
      this.sceneWarning = null;
      this.droppedFileMap = null;
      this.availableUrdfPaths = this.getMergedUrdfModelPaths();
      this.selectedUrdfPath = null;
      this.urdfLoadService.dispose();
      this.sceneController.clearRobot();
      this.sceneController.setModelUpAxis('+Y');
      this.sceneController.setVisualProfile('default');
      this.sceneController.resetView();
      this.motionPlayer.attachRobot(null);
      this.clearMotionPlayback();
      this.clearCurrentObjState();
      this.selectedModelOptionKey = BVH_PREVIEW_MODEL_KEY;
      this.renderUrdfList();
      this.renderPresetOptions();
      this.renderSmplModelList();
      this.renderObjOptions();
      this.setState('idle', {
        title: 'BVH Preview Selected',
        detail: 'Select a BVH motion to load.',
        dropHint: 'Choose a BVH motion from the motions list, or drag and drop a BVH file.',
      });
      return;
    }

    this.isPresetLoading = true;
    this.syncPresetControls();
    this.setState('loading', {
      detail: `Loading ${modelOption.label} ...`,
    });

    try {
      if (modelOption.kind === 'urdf') {
        if (modelOption.files && modelOption.files.length > 0) {
          const modelFileMap = await this.fetchPresetFileMap(modelOption.files);
          this.registerDroppedUrdfFiles(modelFileMap);
        }

        this.availableUrdfPaths = this.getMergedUrdfModelPaths();
        this.selectedUrdfPath = modelOption.path;
        this.renderUrdfList();
        await this.loadSelectedUrdf(modelOption.path);
      } else {
        const modelFileMap =
          modelOption.files && modelOption.files.length > 0
            ? await this.fetchPresetFileMap(modelOption.files)
            : await this.resolveSmplModelFileMap(modelOption.path);
        this.registerDroppedSmplModels(modelFileMap, [modelOption.path]);
        await this.loadSmplModelFromDroppedFiles(modelFileMap, modelOption.path);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Model Load Failed',
        detail: reason,
      });
    } finally {
      this.isPresetLoading = false;
      this.renderUrdfList();
      this.renderPresetOptions();
      this.renderObjOptions();
      this.syncPresetControls();
    }
  }

  private async loadMotionOptionByKey(motionKey: string): Promise<void> {
    const modelOption = this.getCurrentModelOption();
    if (!modelOption) {
      this.setState('error', {
        title: 'Model Required',
        detail: 'Select a model first, then choose a compatible motion.',
      });
      return;
    }

    const motionOption =
      this.getCompatibleMotionOptions(modelOption).find((option) => option.key === motionKey) ?? null;
    if (!motionOption) {
      this.setState('error', {
        title: 'Motion Not Available',
        detail: `Motion "${motionKey}" is not compatible with the selected model.`,
      });
      return;
    }

    if (this.isPresetLoading) {
      return;
    }

    this.selectedMotionOptionKey = motionOption.key;
    this.isPresetLoading = true;
    this.syncPresetControls();
    this.setState('loading', {
      detail: `Loading ${motionOption.label} ...`,
    });

    try {
      const motionFileMap = await this.fetchPresetFileMap(motionOption.files);
      if (motionOption.kind === 'csv') {
        await this.loadMotionFromDroppedFiles(motionFileMap, motionOption.selectedMotionPath);
      } else if (motionOption.kind === 'mimickit') {
        await this.loadMimicKitMotionFromDroppedFiles(motionFileMap, motionOption.selectedMotionPath);
      } else if (motionOption.kind === 'bvh') {
        await this.loadBvhMotionFromDroppedFiles(motionFileMap, motionOption.selectedMotionPath);
      } else {
        const modelFileMap = await this.resolveSmplModelFileMap(modelOption.path);
        const mergedFileMap = this.smplMotionService.mergeDroppedFileMaps(modelFileMap, motionFileMap);
        await this.loadSmplMotionFromDroppedFiles(
          mergedFileMap,
          modelOption.path,
          motionOption.selectedMotionPath,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Motion Load Failed',
        detail: reason,
      });
    } finally {
      this.isPresetLoading = false;
      this.renderUrdfList();
      this.renderPresetOptions();
      this.renderObjOptions();
      this.syncPresetControls();
    }
  }

  private registerDroppedUrdfFiles(fileMap: DroppedFileMap): void {
    for (const [path, file] of fileMap) {
      this.droppedUrdfFileMap.set(path, file);
    }
    this.droppedFileMap = this.droppedUrdfFileMap;
  }

  private registerDroppedSmplModels(fileMap: DroppedFileMap, modelPaths: string[]): void {
    for (const modelPath of modelPaths) {
      const normalizedModelPath = normalizePath(modelPath);
      if (!normalizedModelPath) {
        continue;
      }
      const modelFile = fileMap.get(modelPath) ?? fileMap.get(normalizedModelPath);
      if (!modelFile) {
        continue;
      }
      this.droppedSmplModelFileMap.set(normalizedModelPath, modelFile);
    }
    this.availableSmplModelPaths = mergeUniquePaths(
      this.getMergedSmplModelPaths(),
      this.availableSmplModelPaths,
    );
    this.renderSmplModelList();
  }

  private async resolveSmplModelFileMap(modelPath: string): Promise<DroppedFileMap> {
    const normalizedModelPath = normalizePath(modelPath);
    if (!normalizedModelPath) {
      throw new Error(`Invalid SMPL model path: ${modelPath}`);
    }

    const localDroppedModel = this.droppedSmplModelFileMap.get(normalizedModelPath);
    if (localDroppedModel) {
      const localMap: DroppedFileMap = new Map();
      localMap.set(normalizedModelPath, localDroppedModel);
      return localMap;
    }

    const currentModelFile = this.currentSmplFileMap?.get(normalizedModelPath);
    if (currentModelFile) {
      const currentMap: DroppedFileMap = new Map();
      currentMap.set(normalizedModelPath, currentModelFile);
      return currentMap;
    }

    const presetModel = this.presetSmplModelCatalog.find(
      (candidate) => candidate.mapAs === normalizedModelPath,
    );
    if (presetModel) {
      return this.fetchPresetFileMap([presetModel]);
    }

    throw new Error(`SMPL model "${normalizedModelPath}" is not available in dropped files or presets.`);
  }

  private getCapturedObjCatalogEntries(): PresetAssetFile[] {
    const combined = new Map<string, PresetAssetFile>();
    for (const [rawPath] of this.droppedCapturedObjFileMap) {
      const normalizedPath = normalizePath(rawPath);
      if (!normalizedPath) {
        continue;
      }
      combined.set(normalizedPath, {
        path: normalizedPath,
        mapAs: normalizedPath,
      });
    }

    for (const presetObj of this.capturedObjCatalog) {
      if (combined.has(presetObj.mapAs)) {
        continue;
      }
      combined.set(presetObj.mapAs, presetObj);
    }

    return [...combined.values()];
  }

  private registerDroppedCapturedObjs(fileMap: DroppedFileMap): {
    addedCount: number;
    updatedCount: number;
  } {
    let addedCount = 0;
    let updatedCount = 0;
    const objPaths = this.objLoadService.getAvailableObjPaths(fileMap);
    for (const objPath of objPaths) {
      const normalizedPath = normalizePath(objPath);
      if (!normalizedPath) {
        continue;
      }

      const file = fileMap.get(objPath) ?? fileMap.get(normalizedPath);
      if (!file) {
        continue;
      }

      if (this.droppedCapturedObjFileMap.has(normalizedPath)) {
        updatedCount += 1;
      } else {
        addedCount += 1;
      }
      this.droppedCapturedObjFileMap.set(normalizedPath, file);
    }

    if (objPaths.length > 0) {
      this.renderObjOptions();
      this.syncObjControls();
    }

    return {
      addedCount,
      updatedCount,
    };
  }

  private async resolveCapturedObjSource(candidate: PresetAssetFile): Promise<{
    fileMap: DroppedFileMap;
    preferredObjPath: string;
  }> {
    const normalizedPath = normalizePath(candidate.mapAs);
    if (!normalizedPath) {
      throw new Error(`Invalid captured OBJ path: ${candidate.mapAs}`);
    }

    const localFile = this.droppedCapturedObjFileMap.get(normalizedPath);
    if (localFile) {
      const fileMap: DroppedFileMap = new Map();
      fileMap.set(normalizedPath, localFile);
      return {
        fileMap,
        preferredObjPath: normalizedPath,
      };
    }

    const fileMap = await this.fetchPresetFileMap([candidate]);
    return {
      fileMap,
      preferredObjPath: candidate.mapAs,
    };
  }

  private bindSmplDisplayNodes(sceneObject: unknown): void {
    const sceneNode = sceneObject as any;
    const skinnedMesh = sceneNode?.userData?.smplSkinnedMesh;
    const skeletonHelper = sceneNode?.userData?.smplSkeletonHelper;
    if (skinnedMesh?.isSkinnedMesh && skeletonHelper?.isSkeletonHelper) {
      this.currentSmplDisplayNodes = {
        skinnedMesh,
        skeletonHelper,
      };
      this.applySmplDisplayMode();
      this.syncVisibilityButtons();
      return;
    }

    this.currentSmplDisplayNodes = null;
    this.syncVisibilityButtons();
  }

  private getSmplDisplayModeLabel(): 'Mesh' | 'Skeleton' {
    return this.smplDisplayMode === 'skeleton' ? 'Skeleton' : 'Mesh';
  }

  private applySmplDisplayMode(): void {
    if (!this.currentSmplDisplayNodes) {
      return;
    }

    const { skinnedMesh, skeletonHelper } = this.currentSmplDisplayNodes;
    if (!this.showVisual) {
      skinnedMesh.visible = false;
      skeletonHelper.visible = false;
      return;
    }

    if (this.smplDisplayMode === 'skeleton') {
      skinnedMesh.visible = false;
      skeletonHelper.visible = true;
      return;
    }

    skinnedMesh.visible = true;
    skeletonHelper.visible = false;
  }

  private toggleSmplDisplayMode(): void {
    if (!this.currentSmplDisplayNodes) {
      return;
    }

    this.smplDisplayMode = this.smplDisplayMode === 'mesh' ? 'skeleton' : 'mesh';
    this.applySmplDisplayMode();
    this.syncMotionControls();
    this.syncVisibilityButtons();
    if (this.isModelActiveState()) {
      this.renderCurrentReadyState();
    }
  }

  private clearMotionPlayback(): void {
    this.motionPlayer.pause();
    this.motionPlayer.loadClip(null);
    this.motionPlayer.attachRobot(null);
    this.bvhMotionPlayer.pause();
    this.bvhMotionPlayer.load(null, null);
    this.smplMotionPlayer.pause();
    this.smplMotionPlayer.load(null, null);
    this.currentMotionClip = null;
    this.currentBvhMotion = null;
    this.currentBvhFileMap = null;
    this.currentSmplModel = null;
    this.currentSmplMotion = null;
    this.currentSmplFileMap = null;
    this.currentSmplDisplayNodes = null;
    this.availableSmplModelPaths = this.getMergedSmplModelPaths();
    this.selectedSmplModelPath = null;
    this.currentMotionKind = null;
    this.currentMotionSourcePath = null;
    this.motionWarnings = [];
    this.motionFrameSnapshot = null;
    this.isMotionPlaying = false;
    this.hideJointPanel();
    this.syncMotionControls();
    this.syncVisibilityButtons();
    this.renderSmplModelList();
  }

  private async reloadCurrentBvhWithUnit(nextUnit: BvhLinearUnit): Promise<void> {
    if (!this.currentBvhFileMap) {
      this.bvhLinearUnit = nextUnit;
      this.syncMotionControls();
      return;
    }

    const preferredBvhPath = this.currentMotionSourcePath ?? undefined;
    await this.loadBvhMotionFromDroppedFiles(this.currentBvhFileMap, preferredBvhPath, nextUnit);
  }

  private hasAnyMotion(): boolean {
    return (
      isUrdfMotionKind(this.currentMotionKind) ||
      this.currentMotionKind === 'bvh' ||
      this.currentMotionKind === 'smpl'
    );
  }

  private playActiveMotion(): void {
    if (isUrdfMotionKind(this.currentMotionKind)) {
      this.motionPlayer.play();
      return;
    }
    if (this.currentMotionKind === 'bvh') {
      this.bvhMotionPlayer.play();
      return;
    }
    if (this.currentMotionKind === 'smpl') {
      this.smplMotionPlayer.play();
    }
  }

  private pauseActiveMotion(): void {
    if (isUrdfMotionKind(this.currentMotionKind)) {
      this.motionPlayer.pause();
      return;
    }
    if (this.currentMotionKind === 'bvh') {
      this.bvhMotionPlayer.pause();
      return;
    }
    if (this.currentMotionKind === 'smpl') {
      this.smplMotionPlayer.pause();
    }
  }

  private resetActiveMotion(): void {
    let resetApplied = false;
    if (isUrdfMotionKind(this.currentMotionKind)) {
      this.motionPlayer.reset();
      resetApplied = true;
    } else if (this.currentMotionKind === 'bvh') {
      this.bvhMotionPlayer.reset();
      resetApplied = true;
    } else if (this.currentMotionKind === 'smpl') {
      this.smplMotionPlayer.reset();
      resetApplied = true;
    }

    if (!resetApplied) {
      return;
    }

    this.sceneController.syncGroundToCurrentRobot();
    this.sceneController.syncViewToCurrentRobot();
  }

  private seekActiveMotion(frameIndex: number): void {
    if (isUrdfMotionKind(this.currentMotionKind)) {
      this.motionPlayer.seek(frameIndex);
      return;
    }
    if (this.currentMotionKind === 'bvh') {
      this.bvhMotionPlayer.seek(frameIndex);
      return;
    }
    if (this.currentMotionKind === 'smpl') {
      this.smplMotionPlayer.seek(frameIndex);
    }
  }

  private handleDragStateChange(isDragging: boolean): void {
    if (this.viewerState === 'loading') {
      return;
    }

    if (isDragging) {
      this.setState('drag_over');
      return;
    }

    if (this.lastLoadResult) {
      this.renderReadyState(this.lastLoadResult);
      return;
    }

    if (this.currentMotionKind === 'bvh' && this.currentBvhMotion) {
      this.renderBvhReadyState();
      return;
    }

    if (this.currentMotionKind === 'smpl' && this.currentSmplMotion) {
      this.renderSmplReadyState();
      return;
    }

    if (this.currentSmplModel) {
      this.renderSmplModelReadyState();
      return;
    }

    if (this.currentObjModel) {
      this.renderObjReadyState();
      return;
    }

    this.setState('idle');
  }

  private isModelActiveState(): boolean {
    return this.viewerState === 'model_ready' || this.viewerState === 'playing';
  }

  private getLoadedViewerState(): ViewerState {
    return this.isMotionPlaying && this.hasAnyMotion() ? 'playing' : 'model_ready';
  }

  private setState(
    state: ViewerState,
    overrides: {
      title?: string;
      modelTitle?: string;
      detail?: string;
      dropHint?: string;
      warnings?: string[];
    } = {},
  ): void {
    if (state !== 'error') {
      this.clearRecoverReadyTimer();
    }

    this.viewerState = state;
    this.titleOverride = this.isModelActiveState() ? null : (overrides.title ?? null);
    this.modelTitleOverride = overrides.modelTitle ?? null;
    this.detailOverride = overrides.detail ?? null;
    this.dropHintOverride = overrides.dropHint ?? null;
    this.warnings = overrides.warnings ? [...overrides.warnings] : [];
    this.renderState();
  }

  private renderState(): void {
    const copy = getStateCopy(this.viewerState);
    this.appRoot.dataset.viewerState = this.viewerState;
    this.stateChip.textContent = copy.chip;
    this.statusTitle.textContent = this.titleOverride ?? copy.title;
    this.modelTitle.textContent = this.modelTitleOverride ?? 'Model';
    this.statusDetail.textContent = this.detailOverride ?? '';
    appendTextWithHttpLinks(this.dropHint, this.dropHintOverride ?? copy.dropHint);

    this.statusWarnings.innerHTML = '';
    for (const warning of this.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      this.statusWarnings.appendChild(item);
    }
    this.statusWarnings.hidden = this.warnings.length === 0;

    this.syncVisibilityButtons();
    this.syncMotionWarningList();
    this.syncModePropsPanel();
    this.syncDropOverlayDockState();
  }

  private syncDropOverlayDockState(): void {
    this.appRoot.dataset.dropOverlayDocked = this.isDropOverlayDocked ? 'true' : 'false';
    const isCornerPosition = this.isDropOverlayDocked || this.viewerState === 'playing';
    const label = isCornerPosition ? 'Restore panel to center' : 'Move panel to bottom left';
    this.dropOverlayDockButton.textContent = isCornerPosition ? '□' : '−';
    this.dropOverlayDockButton.ariaLabel = label;
    this.dropOverlayDockButton.title = label;
    this.dropOverlayDockButton.hidden = false;
    this.dropOverlayDockButton.disabled = this.viewerState === 'playing';
  }

  private renderReadyState(result: LoadedRobotResult): void {
    const modelLabel = this.formatAssetFileLabel(result.selectedUrdfPath, 'model.urdf');
    const detailLines = [`${result.jointCount} joints, ${result.linkCount} links.`];

    this.setState(this.getLoadedViewerState(), {
      title: `Loaded ${result.robotName || 'URDF Robot'}`,
      modelTitle: `Model: ${modelLabel}`,
      detail: detailLines.join('\n'),
      dropHint: this.buildReadyDropHint(),
      warnings: this.collectModelWarnings(result.warnings),
    });
    
    // 显示创建新动作的按钮
    this.showCreateMotionButton();
  }

  private showCreateMotionButton(): void {
    // 检查是否已经存在创建动作的按钮
    if (document.getElementById('create-motion-btn')) {
      return;
    }
    
    // 在dataset-panel中添加创建动作的按钮
    const datasetPanel = document.getElementById('dataset-panel');
    if (datasetPanel) {
      const presetPicker = datasetPanel.querySelector('.preset-picker');
      if (presetPicker) {
        const createButton = document.createElement('button');
        createButton.id = 'create-motion-btn';
        createButton.className = 'toggle-chip';
        createButton.textContent = 'Create Motion';
        createButton.style.width = '100%';
        createButton.style.marginBottom = '0.5rem';
        createButton.addEventListener('click', () => this.showCreateMotionDialog());
        // 将按钮添加到presetPicker的开头，这样就会显示在文字描述的上面
        presetPicker.insertBefore(createButton, presetPicker.firstChild);
      }
    }
  }



  private showCreateMotionDialog(): void {
    // 创建对话框
    const dialog = document.createElement('div');
    dialog.id = 'create-motion-dialog';
    dialog.style.position = 'fixed';
    dialog.style.top = '50%';
    dialog.style.left = '50%';
    dialog.style.transform = 'translate(-50%, -50%)';
    dialog.style.background = 'rgba(6, 12, 17, 0.95)';
    dialog.style.border = '1px solid rgba(146, 205, 236, 0.35)';
    dialog.style.borderRadius = '16px';
    dialog.style.padding = '2rem';
    dialog.style.zIndex = '1000';
    dialog.style.minWidth = '300px';
    dialog.style.boxShadow = '0 25px 45px rgba(1, 7, 10, 0.45)';
    dialog.style.backdropFilter = 'blur(8px) saturate(120%)';
    
    // 对话框标题
    const title = document.createElement('h3');
    title.textContent = 'Create New Motion';
    title.style.color = 'var(--text-main)';
    title.style.marginTop = '0';
    title.style.marginBottom = '1.5rem';
    dialog.appendChild(title);
    
    // 表单
    const form = document.createElement('form');
    form.style.display = 'grid';
    form.style.gap = '1rem';
    
    // 导出格式选择
    const formatDiv = document.createElement('div');
    const formatLabel = document.createElement('label');
    formatLabel.textContent = 'Export Format:';
    formatLabel.style.color = 'var(--text-muted)';
    formatLabel.style.fontSize = '0.8rem';
    formatDiv.appendChild(formatLabel);
    const formatSelect = document.createElement('select');
    formatSelect.id = 'motion-format';
    formatSelect.style.width = '100%';
    formatSelect.style.padding = '0.5rem';
    formatSelect.style.border = '1px solid rgba(146, 205, 236, 0.35)';
    formatSelect.style.borderRadius = '8px';
    formatSelect.style.background = 'rgba(7, 22, 32, 0.8)';
    formatSelect.style.color = 'var(--text-main)';
    formatSelect.style.font = 'inherit';
    const formats = ['csv', 'gmr', 'mimickit'];
    formats.forEach(format => {
      const option = document.createElement('option');
      option.value = format;
      option.textContent = format.toUpperCase();
      formatSelect.appendChild(option);
    });
    formatDiv.appendChild(formatSelect);
    form.appendChild(formatDiv);
    
    // FPS设置
    const fpsDiv = document.createElement('div');
    const fpsLabel = document.createElement('label');
    fpsLabel.textContent = 'FPS:';
    fpsLabel.style.color = 'var(--text-muted)';
    fpsLabel.style.fontSize = '0.8rem';
    fpsDiv.appendChild(fpsLabel);
    const fpsInput = document.createElement('input');
    fpsInput.type = 'number';
    fpsInput.id = 'motion-fps';
    fpsInput.value = '30';
    fpsInput.min = '0.1';
    fpsInput.step = '0.1';
    fpsInput.style.width = '100%';
    fpsInput.style.padding = '0.5rem';
    fpsInput.style.border = '1px solid rgba(146, 205, 236, 0.35)';
    fpsInput.style.borderRadius = '8px';
    fpsInput.style.background = 'rgba(7, 22, 32, 0.8)';
    fpsInput.style.color = 'var(--text-main)';
    fpsInput.style.font = 'inherit';
    fpsDiv.appendChild(fpsInput);
    form.appendChild(fpsDiv);
    
    // 总帧数设置
    const frameCountDiv = document.createElement('div');
    const frameCountLabel = document.createElement('label');
    frameCountLabel.textContent = 'Total Frames:';
    frameCountLabel.style.color = 'var(--text-muted)';
    frameCountLabel.style.fontSize = '0.8rem';
    frameCountDiv.appendChild(frameCountLabel);
    const frameCountInput = document.createElement('input');
    frameCountInput.type = 'number';
    frameCountInput.id = 'motion-frame-count';
    frameCountInput.value = '100';
    frameCountInput.min = '2';
    frameCountInput.step = '1';
    frameCountInput.style.width = '100%';
    frameCountInput.style.padding = '0.5rem';
    frameCountInput.style.border = '1px solid rgba(146, 205, 236, 0.35)';
    frameCountInput.style.borderRadius = '8px';
    frameCountInput.style.background = 'rgba(7, 22, 32, 0.8)';
    frameCountInput.style.color = 'var(--text-main)';
    frameCountInput.style.font = 'inherit';
    frameCountDiv.appendChild(frameCountInput);
    form.appendChild(frameCountDiv);
    
    // 按钮
    const buttonsDiv = document.createElement('div');
    buttonsDiv.style.display = 'flex';
    buttonsDiv.style.gap = '0.5rem';
    buttonsDiv.style.justifyContent = 'flex-end';
    
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = 'Cancel';
    cancelButton.className = 'toggle-chip ghost';
    cancelButton.addEventListener('click', () => {
      dialog.remove();
      overlay.remove();
    });
    buttonsDiv.appendChild(cancelButton);
    
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.textContent = 'Create';
    createButton.className = 'toggle-chip';
    createButton.addEventListener('click', () => {
      const format = formatSelect.value;
      const fps = parseFloat(fpsInput.value);
      const frameCount = parseInt(frameCountInput.value, 10);
      this.createNewMotion(format, fps, frameCount);
      dialog.remove();
      overlay.remove();
    });
    buttonsDiv.appendChild(createButton);
    
    form.appendChild(buttonsDiv);
    dialog.appendChild(form);
    
    // 遮罩
    const overlay = document.createElement('div');
    overlay.id = 'create-motion-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0, 0, 0, 0.5)';
    overlay.style.zIndex = '999';
    overlay.addEventListener('click', () => {
      dialog.remove();
      overlay.remove();
    });
    
    document.body.appendChild(overlay);
    document.body.appendChild(dialog);
  }

  private createNewMotion(format: string, fps: number, frameCount: number): void {
    if (!this.lastLoadResult) {
      return;
    }
    
    const motionSchema = this.lastLoadResult.motionSchema;
    const jointCount = motionSchema.jointNames.length;
    const stride = DEFAULT_ROOT_COMPONENT_COUNT + jointCount;
    
    // 创建一个新的动作片段，初始化为默认值
    const data = new Float32Array(frameCount * stride);
    
    // 初始化所有帧为默认值（root位置为0,0,0，旋转为单位四元数，关节角度为0）
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const baseIndex = frameIndex * stride;
      // root位置 (x, y, z)
      data[baseIndex] = 0;
      data[baseIndex + 1] = 0;
      data[baseIndex + 2] = 0;
      // root旋转 (qx, qy, qz, qw) - 单位四元数
      data[baseIndex + 3] = 0;
      data[baseIndex + 4] = 0;
      data[baseIndex + 5] = 0;
      data[baseIndex + 6] = 1;
      // 关节角度
      for (let jointIndex = 0; jointIndex < jointCount; jointIndex++) {
        data[baseIndex + DEFAULT_ROOT_COMPONENT_COUNT + jointIndex] = 0;
      }
    }
    
    const clip: MotionClip = {
      name: 'New Motion',
      sourcePath: 'new_motion',
      fps,
      frameCount,
      stride,
      schema: motionSchema,
      csvMode: 'ordered',
      sourceColumnCount: stride,
      data,
    };
    
    // 应用新创建的动作
    this.applyLoadedUrdfMotion(
      this.lastLoadResult,
      clip,
      format as UrdfMotionKind,
      'new_motion',
      []
    );
    
    // 显示关节控制面板
    this.showJointPanel();
  }

  private renderBvhReadyState(): void {
    if (!this.currentBvhMotion) {
      return;
    }

    const bvhLabel = this.formatAssetFileLabel(
      this.currentBvhMotion.sourcePath,
      `${this.currentBvhMotion.name}.bvh`,
    );
    const detail = `${this.currentBvhMotion.jointCount} animated joints, ${this.currentBvhMotion.frameCount} frames.`;

    this.setState(this.getLoadedViewerState(), {
      title: `Loaded ${this.currentBvhMotion.name}`,
      modelTitle: `Model: ${bvhLabel}`,
      detail,
      dropHint: this.buildReadyDropHint(),
      warnings: this.collectModelWarnings([]),
    });
  }

  private renderSmplReadyState(): void {
    if (!this.currentSmplMotion) {
      return;
    }

    const modelLabel = this.formatAssetFileLabel(
      this.currentSmplMotion.modelSourcePath,
      `${this.currentSmplMotion.modelName}.npz`,
    );
    const detailLines = [
      `${this.currentSmplMotion.jointCount} joints, ${this.currentSmplMotion.vertexCount} vertices, ${this.currentSmplMotion.frameCount} frames.`,
    ];
    const detail = detailLines.join('\n');
    const modelWarnings = this.getSmplModelWarningsFromMotionWarnings();

    this.setState(this.getLoadedViewerState(), {
      title: `Loaded ${this.currentSmplMotion.motionName}`,
      modelTitle: `Model: ${modelLabel}`,
      detail,
      dropHint: this.buildReadyDropHint(),
      warnings: this.collectModelWarnings(modelWarnings),
    });
  }

  private renderSmplModelReadyState(): void {
    if (!this.currentSmplModel) {
      return;
    }

    const modelLabel = this.formatAssetFileLabel(
      this.currentSmplModel.modelSourcePath,
      `${this.currentSmplModel.modelName}.npz`,
    );
    const detail = `${this.currentSmplModel.jointCount} joints, ${this.currentSmplModel.vertexCount} vertices.`;
    const modelWarnings = this.getSmplModelWarningsFromMotionWarnings();

    this.setState(this.getLoadedViewerState(), {
      title: `Loaded ${this.currentSmplModel.modelName}`,
      modelTitle: `Model: ${modelLabel}`,
      detail,
      dropHint: this.buildReadyDropHint(),
      warnings: this.collectModelWarnings(modelWarnings),
    });
  }

  private renderObjReadyState(): void {
    if (!this.currentObjModel) {
      return;
    }

    const modelLabel = this.formatAssetFileLabel(
      this.currentObjModel.modelSourcePath,
      `${this.currentObjModel.modelName}.obj`,
    );
    const detail = `${this.currentObjModel.meshCount} meshes.`;

    this.setState(this.getLoadedViewerState(), {
      title: `Loaded ${this.currentObjModel.modelName}`,
      modelTitle: `Model: ${modelLabel}`,
      detail,
      dropHint: this.buildReadyDropHint(),
      warnings: this.collectModelWarnings(this.motionWarnings),
    });
  }

  private renderCurrentReadyState(): void {
    if (this.lastLoadResult) {
      this.renderReadyState(this.lastLoadResult);
      return;
    }

    if (this.currentMotionKind === 'bvh' && this.currentBvhMotion) {
      this.renderBvhReadyState();
      return;
    }

    if (this.currentMotionKind === 'smpl' && this.currentSmplMotion) {
      this.renderSmplReadyState();
      return;
    }

    if (this.currentSmplModel) {
      this.renderSmplModelReadyState();
      return;
    }

    if (this.currentObjModel) {
      this.renderObjReadyState();
    }
  }

  private clearRecoverReadyTimer(): void {
    if (this.recoverReadyTimer === null) {
      return;
    }

    window.clearTimeout(this.recoverReadyTimer);
    this.recoverReadyTimer = null;
  }

  private hasRecoverableReadyState(): boolean {
    return Boolean(
      this.lastLoadResult ||
      (this.currentMotionKind === 'bvh' && this.currentBvhMotion) ||
      (this.currentMotionKind === 'smpl' && this.currentSmplMotion) ||
      this.currentSmplModel ||
      this.currentObjModel,
    );
  }

  private scheduleRecoverToReady(delayMs = 1400): void {
    this.clearRecoverReadyTimer();
    if (!this.hasRecoverableReadyState()) {
      return;
    }

    this.recoverReadyTimer = window.setTimeout(() => {
      this.recoverReadyTimer = null;
      if (this.viewerState === 'error') {
        this.renderCurrentReadyState();
      }
    }, delayMs);
  }

  private showRecoverableDropError(title: string, detail: string, dropHint: string): void {
    if (this.hasRecoverableReadyState()) {
      this.recoverableDropHint = `${title}. ${dropHint}`;
    }

    this.setState('error', {
      title,
      detail,
      dropHint,
    });
    this.scheduleRecoverToReady();
  }

  private buildReadyDropHint(): string | undefined {
    if (!this.recoverableDropHint) {
      return undefined;
    }

    const baseReadyHint = getStateCopy('model_ready').dropHint;
    return `${baseReadyHint} Last warning: ${this.recoverableDropHint}`;
  }

  private collectModelWarnings(baseWarnings: string[]): string[] {
    const merged = new Set<string>(baseWarnings);
    if (this.sceneWarning) {
      merged.add(this.sceneWarning);
    }
    return [...merged];
  }

  private isSmplModelWarning(warning: string): boolean {
    const normalized = warning.toLowerCase();
    return (
      normalized.includes('model supports') ||
      normalized.includes('model appears to be') ||
      normalized.includes('current model gender') ||
      normalized.includes('loaded smpl model;') ||
      normalized.includes('smpl model') ||
      normalized.includes('model has') ||
      normalized.includes('gender mismatch')
    );
  }

  private getSmplModelWarningsFromMotionWarnings(): string[] {
    if (!(this.currentSmplModel || this.currentSmplMotion)) {
      return [];
    }
    return this.motionWarnings.filter((warning) => this.isSmplModelWarning(warning));
  }

  private getMotionPanelWarnings(): string[] {
    if (this.currentMotionKind !== 'smpl') {
      return [...this.motionWarnings];
    }

    const modelWarnings = new Set(this.getSmplModelWarningsFromMotionWarnings());
    return this.motionWarnings.filter((warning) => !modelWarnings.has(warning));
  }

  private syncMotionWarningList(): void {
    this.motionWarningsList.innerHTML = '';
    if (!this.hasAnyMotion()) {
      this.motionWarningsList.hidden = true;
      return;
    }

    const warnings = this.getMotionPanelWarnings();
    for (const warning of warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      this.motionWarningsList.appendChild(item);
    }
    this.motionWarningsList.hidden = warnings.length === 0;
  }

  private formatAssetFileLabel(pathOrName: string | null | undefined, fallback: string): string {
    if (!pathOrName) {
      return fallback;
    }

    const baseName = getBaseName(pathOrName);
    if (baseName) {
      return baseName;
    }

    const normalized = normalizePath(pathOrName);
    if (normalized) {
      return normalized;
    }

    const trimmed = pathOrName.trim();
    return trimmed || fallback;
  }

  private appendModePropsChip(text: string): void {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'toggle-chip active mode-props-chip mode-props-chip--button mode-props-chip--static';
    chip.tabIndex = -1;
    chip.textContent = text;
    this.modePropsList.appendChild(chip);
  }

  private appendModePropsBvhUnitControl(): void {
    const control = document.createElement('label');
    control.className = 'mode-props-control';

    const label = document.createElement('span');
    label.className = 'mode-props-control__label';
    label.textContent = 'Unit:';

    const select = document.createElement('select');
    select.className = 'mode-props-control__select';
    for (const unit of BVH_LINEAR_UNITS) {
      const option = document.createElement('option');
      option.value = unit;
      option.textContent = unit;
      select.appendChild(option);
    }
    select.value = this.currentBvhMotion?.linearUnit ?? this.bvhLinearUnit;
    select.disabled = this.viewerState === 'loading';
    select.addEventListener('change', this.onModePropsBvhUnitChange);

    control.append(label, select);
    this.modePropsList.appendChild(control);
  }

  private appendModePropsSmplRenderControl(): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-chip active mode-props-chip mode-props-chip--button';
    button.textContent = `Render: ${this.getSmplDisplayModeLabel()}`;
    button.disabled = !this.currentSmplDisplayNodes;
    button.addEventListener('click', this.onModePropsSmplRenderClick);
    this.modePropsList.appendChild(button);
  }

  private syncModePropsPanel(): void {
    this.modePropsList.innerHTML = '';
    let hasEntries = false;

    if (this.currentMotionKind === 'bvh' && this.currentBvhMotion) {
      this.appendModePropsBvhUnitControl();
      hasEntries = true;
    }

    if (this.currentSmplMotion || this.currentSmplModel || this.currentSmplDisplayNodes) {
      this.appendModePropsSmplRenderControl();
      hasEntries = true;
    }

    if (this.currentSmplMotion) {
      const motionGender = this.currentSmplMotion.motionGender ?? 'unknown';
      this.appendModePropsChip(`Gender: ${motionGender}`);
      hasEntries = true;
      if (this.currentSmplMotion.objectName) {
        this.appendModePropsChip(`Object: ${this.currentSmplMotion.objectName}`);
      }
    } else if (this.currentSmplModel) {
      const modelGender = this.currentSmplModel.modelGender ?? 'unknown';
      this.appendModePropsChip(`Gender: ${modelGender}`);
      hasEntries = true;
    }

    if (!hasEntries) {
      this.modePropsPanel.hidden = true;
      return;
    }

    this.modePropsPanel.hidden = false;
    this.modePropsList.hidden = false;
  }

  private applyUrdfMotionFps(nextFps: number): void {
    if (!isUrdfMotionKind(this.currentMotionKind) || !this.currentMotionClip) {
      return;
    }

    const safeFps = Math.max(0.1, Number(nextFps.toFixed(3)));
    this.currentMotionClip.fps = safeFps;
    const currentFrame = this.motionFrameSnapshot?.frameIndex ?? 0;
    this.motionPlayer.seek(currentFrame);
    this.syncMotionControls();

    if (this.isModelActiveState()) {
      this.renderCurrentReadyState();
    }
  }

  private applyBvhMotionFps(nextFps: number): void {
    if (this.currentMotionKind !== 'bvh' || !this.currentBvhMotion) {
      return;
    }

    const safeFps = Math.max(0.1, Number(nextFps.toFixed(3)));
    this.currentBvhMotion.fps = safeFps;
    this.bvhMotionPlayer.setFps(safeFps);
    this.syncMotionControls();
    if (this.isModelActiveState()) {
      this.renderCurrentReadyState();
    }
  }

  private applySmplMotionFps(nextFps: number): void {
    if (this.currentMotionKind !== 'smpl' || !this.currentSmplMotion) {
      return;
    }

    const safeFps = Math.max(0.1, Number(nextFps.toFixed(3)));
    this.currentSmplMotion.fps = safeFps;
    this.smplMotionPlayer.setFps(safeFps);
    this.syncMotionControls();
    if (this.isModelActiveState()) {
      this.renderCurrentReadyState();
    }
  }

  private getActiveMotionLabel(): string | null {
    if (this.currentMotionKind === 'csv') {
      return this.currentMotionSourcePath
        ? this.formatAssetFileLabel(this.currentMotionSourcePath, 'motion.csv')
        : null;
    }

    if (this.currentMotionKind === 'mimickit') {
      return this.currentMotionSourcePath
        ? this.formatAssetFileLabel(this.currentMotionSourcePath, 'motion.pkl')
        : null;
    }

    if (this.currentMotionKind === 'bvh' && this.currentBvhMotion) {
      return this.formatAssetFileLabel(
        this.currentBvhMotion.sourcePath,
        `${this.currentBvhMotion.name}.bvh`,
      );
    }

    if (this.currentMotionKind === 'smpl' && this.currentSmplMotion) {
      return this.formatAssetFileLabel(
        this.currentSmplMotion.motionSourcePath,
        `${this.currentSmplMotion.motionName}.npz`,
      );
    }

    return null;
  }

  private formatMotionFpsValue(fps: number): string {
    return Number(fps.toFixed(3)).toString();
  }

  private syncMotionFpsInput(): void {
    if (!this.hasAnyMotion()) {
      this.motionFpsControl.hidden = true;
      this.motionFpsInput.disabled = true;
      this.motionFpsInput.value = '30';
      return;
    }

    const fps =
      this.currentMotionClip?.fps ?? this.currentBvhMotion?.fps ?? this.currentSmplMotion?.fps ?? 30;
    this.motionFpsControl.hidden = false;
    this.motionFpsInput.disabled = false;
    this.motionFpsInput.value = this.formatMotionFpsValue(fps);
  }

  private syncVisibilityButtons(): void {
    const hasUrdfModel = Boolean(this.lastLoadResult);
    this.urdfVisualControls.hidden = !hasUrdfModel;
    this.showVisualButton.disabled = !hasUrdfModel;
    this.showCollisionButton.disabled = !hasUrdfModel;
    this.showVisualButton.classList.toggle('active', this.showVisual);
    this.showCollisionButton.classList.toggle('active', this.showCollision);
    const isRootLock = this.viewMode === 'root_lock';
    this.viewModeButton.textContent = isRootLock ? 'View: Root Lock' : 'View: Free';
    this.viewModeButton.classList.toggle('active', isRootLock);
  }

  private syncMotionControls(): void {
    const hasMotion = this.hasAnyMotion();
    this.motionControlsSection.hidden = !hasMotion;
    this.motionPlayButton.disabled = !hasMotion;
    this.motionResetButton.disabled = !hasMotion;
    this.insertKeyframeButton.disabled = !hasMotion;
    this.motionFrameCountInput.disabled = !hasMotion;

    if (!hasMotion) {
      this.motionTitle.textContent = 'Motion';
      this.motionPlayButton.textContent = 'Play';
      this.motionPlayButton.classList.remove('active');
      this.motionFrameSlider.min = '0';
      this.motionFrameSlider.max = '0';
      this.motionFrameSlider.value = '0';
      this.motionFrameLabel.textContent = 'Frame 0 / 0';
      this.motionFrameCountInput.value = '100';
      this.keyframes.clear();
      this.syncMotionFpsInput();
      this.syncMotionWarningList();
      return;
    }

    const motionLabel = this.getActiveMotionLabel();
    this.motionTitle.textContent = motionLabel ? `Motion: ${motionLabel}` : 'Motion';
    this.motionPlayButton.textContent = this.isMotionPlaying ? 'Pause' : 'Play';
    this.motionPlayButton.classList.toggle('active', this.isMotionPlaying);

    const defaultFrameCount =
      this.currentMotionClip?.frameCount ??
      this.currentBvhMotion?.frameCount ??
      this.currentSmplMotion?.frameCount ??
      0;
    const defaultFps =
      this.currentMotionClip?.fps ?? this.currentBvhMotion?.fps ?? this.currentSmplMotion?.fps ?? 30;

    const snapshot =
      this.motionFrameSnapshot ??
      ({
        frameIndex: 0,
        frameCount: defaultFrameCount,
        fps: defaultFps,
        timeSeconds: 0,
      } as MotionFrameSnapshot);

    const maxFrame = Math.max(snapshot.frameCount - 1, 0);
    this.motionFrameSlider.min = '0';
    this.motionFrameSlider.max = String(maxFrame);
    this.motionFrameSlider.step = '1';
    this.motionFrameSlider.value = String(snapshot.frameIndex);
    this.motionFrameLabel.textContent = `Frame ${snapshot.frameIndex + 1} / ${snapshot.frameCount}`;
    this.motionFrameCountInput.value = String(snapshot.frameCount);
    this.updateKeyframeMarkers();
    this.syncMotionFpsInput();
    this.syncMotionWarningList();
  }

  private toggleViewMode(): void {
    this.viewMode = this.viewMode === 'free' ? 'root_lock' : 'free';
    this.sceneController.setViewMode(this.viewMode);
    this.syncVisibilityButtons();

    if (this.isModelActiveState()) {
      this.renderCurrentReadyState();
    }
  }

  private resolvePresetAssetUrl(path: string): string {
    const relativePath = normalizePresetFetchPath(path);
    return new URL(relativePath, document.baseURI).toString();
  }

  private renderPresetOptions(): void {
    const motionOptions = this.getCompatibleMotionOptions();
    const selectedMotionKey = this.getCurrentMotionOptionKey(motionOptions);
    const modelOption = this.getCurrentModelOption();

    this.presetSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    if (!modelOption) {
      placeholder.textContent = 'Select model first';
    } else if (motionOptions.length === 0) {
      placeholder.textContent = 'No compatible motions';
    } else {
      placeholder.textContent = 'Select motion...';
    }
    this.presetSelect.appendChild(placeholder);

    for (const preset of motionOptions) {
      const option = document.createElement('option');
      option.value = preset.key;
      option.textContent = preset.label;
      option.title = preset.description || preset.label;
      this.presetSelect.appendChild(option);
    }

    if (selectedMotionKey && motionOptions.some((option) => option.key === selectedMotionKey)) {
      this.presetSelect.value = selectedMotionKey;
    } else {
      this.presetSelect.value = '';
    }
  }

  private renderObjOptions(): void {
    const catalog = this.getCapturedObjCatalogEntries();
    const hasCatalog = catalog.length > 0;
    const modelOption = this.getCurrentModelOption();
    const supportsObjects = modelOption?.kind === 'smpl';

    this.objSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    if (!modelOption) {
      placeholder.textContent = 'Select model first';
    } else if (!supportsObjects) {
      placeholder.textContent = 'Objects are for SMPL';
    } else if (hasCatalog) {
      placeholder.textContent = 'No object';
    } else {
      placeholder.textContent = 'No objects available';
    }
    this.objSelect.appendChild(placeholder);

    for (const candidate of catalog) {
      const option = document.createElement('option');
      option.value = candidate.mapAs;
      option.textContent = formatCapturedObjLabel(candidate.mapAs);
      option.title = candidate.mapAs;
      this.objSelect.appendChild(option);
    }

    this.syncObjSelectionToCurrentModel();
  }

  private syncPresetControls(): void {
    const hasMotionOptions = this.getCompatibleMotionOptions().length > 0;
    const hasSelection = this.presetSelect.value.trim().length > 0;

    this.presetSelect.disabled = this.isPresetLoading || !hasMotionOptions;
    this.presetLoadButton.disabled = this.isPresetLoading || !hasSelection;
    this.presetLoadButton.textContent = this.isPresetLoading ? 'Loading...' : 'Load Preset';
    this.syncObjControls();
  }

  private syncObjControls(): void {
    const hasCatalog = this.getCapturedObjCatalogEntries().length > 0;
    const supportsObjects = this.getCurrentModelOption()?.kind === 'smpl';
    this.objSelect.disabled =
      this.isPresetLoading || this.isObjCatalogLoading || !hasCatalog || !supportsObjects;
  }

  private async initializePresetManifest(): Promise<void> {
    this.presetManifest = null;
    this.presetUrdfCatalog = [];
    this.presetSmplModelCatalog = [];
    this.presetModelCatalog = [];
    this.presetMotionCatalog = [];
    this.capturedObjCatalog = buildDefaultCapturedObjectPresetFiles();
    this.availableUrdfPaths = this.getMergedUrdfModelPaths();
    this.availableSmplModelPaths = this.getMergedSmplModelPaths();
    this.renderPresetOptions();
    this.renderUrdfList();
    this.renderSmplModelList();
    this.renderObjOptions();
    this.syncPresetControls();

    try {
      const response = await fetch(this.resolvePresetAssetUrl('presets/presets.json'), {
        cache: 'no-cache',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading presets/presets.json.`);
      }

      const rawManifest = (await response.json()) as unknown;
      const parsedManifest = parsePresetManifest(rawManifest);
      this.presetManifest = parsedManifest;
      this.presetUrdfCatalog = collectPresetUrdfModels(parsedManifest);
      this.presetSmplModelCatalog = collectPresetSmplModels(parsedManifest);
      this.presetModelCatalog = collectPresetModelOptions(parsedManifest);
      this.presetMotionCatalog = collectPresetMotionOptions(parsedManifest);
      this.capturedObjCatalog =
        parsedManifest.capturedObjects.length > 0
          ? parsedManifest.capturedObjects
          : buildDefaultCapturedObjectPresetFiles();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Preset catalog unavailable: ${reason}`);
      this.presetManifest = { presets: [], capturedObjects: [] };
      this.presetUrdfCatalog = [];
      this.presetSmplModelCatalog = [];
      this.presetModelCatalog = [];
      this.presetMotionCatalog = [];
      this.capturedObjCatalog = buildDefaultCapturedObjectPresetFiles();
    }

    this.availableUrdfPaths = this.getMergedUrdfModelPaths();
    this.availableSmplModelPaths = this.getMergedSmplModelPaths();
    this.renderPresetOptions();
    this.renderUrdfList();
    this.renderSmplModelList();
    this.renderObjOptions();
    this.syncPresetControls();
  }

  private getPresetById(presetId: string): ViewerPresetDefinition | null {
    const presets = this.presetManifest?.presets ?? [];
    return presets.find((preset) => preset.id === presetId) ?? null;
  }

  private async fetchPresetFileMap(files: PresetAssetFile[]): Promise<DroppedFileMap> {
    const fileMap: DroppedFileMap = new Map();

    for (const fileDef of files) {
      if (fileMap.has(fileDef.mapAs)) {
        throw new Error(`Duplicate preset file key detected: ${fileDef.mapAs}`);
      }

      const response = await fetch(this.resolvePresetAssetUrl(fileDef.path), {
        cache: 'no-cache',
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch preset file ${fileDef.path}: HTTP ${response.status}.`);
      }

      const blob = await response.blob();
      const fileName = getBaseName(fileDef.mapAs) || getBaseName(fileDef.path) || 'asset.bin';
      const file = new File([blob], fileName, { type: blob.type });
      fileMap.set(fileDef.mapAs, file);
    }

    return fileMap;
  }

  private async loadCapturedObjByMapPath(mapPath: string): Promise<void> {
    const normalizedPath = normalizePath(mapPath);
    if (!normalizedPath) {
      return;
    }

    const selectedObj = this.getCapturedObjCatalogEntries().find(
      (candidate) => candidate.mapAs === normalizedPath,
    );
    if (!selectedObj) {
      this.showRecoverableDropError(
        'Captured OBJ Not Found',
        `Captured OBJ "${mapPath}" is not registered in catalog.`,
        'Select another OBJ from the list or drop an OBJ file manually.',
      );
      return;
    }

    if (this.isObjCatalogLoading) {
      return;
    }

    this.isObjCatalogLoading = true;
    this.syncObjControls();

    try {
      const resolved = await this.resolveCapturedObjSource(selectedObj);
      await this.loadObjModelFromDroppedFiles(resolved.fileMap, resolved.preferredObjPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'OBJ Load Failed',
        detail: reason,
      });
    } finally {
      this.isObjCatalogLoading = false;
      this.syncObjControls();
    }
  }

  private buildSinglePresetFile(path: string): PresetAssetFile {
    const normalizedPath = normalizePresetFetchPath(path);
    if (!normalizedPath) {
      throw new Error(`Invalid preset path: ${path}`);
    }

    return {
      path: normalizedPath,
      mapAs: normalizePresetMapPath(normalizedPath),
    };
  }

  private async loadPresetById(presetId: string): Promise<void> {
    const preset = this.getPresetById(presetId);
    if (!preset) {
      this.setState('error', {
        title: 'Preset Not Found',
        detail: `Preset "${presetId}" was not found in catalog.`,
      });
      return;
    }

    if (this.isPresetLoading) {
      return;
    }

    this.isPresetLoading = true;
    this.syncPresetControls();
    this.setState('loading', {
      detail: `Loading preset ${preset.label} ...`,
    });

    try {
      if (preset.motion?.kind === 'smpl') {
        if (!preset.model) {
          throw new Error(`Preset "${preset.label}" requires a model section for SMPL playback.`);
        }

        const modelFiles =
          preset.model.files && preset.model.files.length > 0
            ? preset.model.files
            : preset.model.urdfPath
              ? [this.buildSinglePresetFile(preset.model.urdfPath)]
              : [];
        if (modelFiles.length === 0) {
          throw new Error(`Preset "${preset.label}" does not define SMPL model files.`);
        }

        if ((!preset.motion.files || preset.motion.files.length === 0) && !preset.motion.path) {
          throw new Error(`Preset "${preset.label}" does not define SMPL motion files.`);
        }

        const motionFiles =
          preset.motion.files && preset.motion.files.length > 0
            ? preset.motion.files
            : [this.buildSinglePresetFile(preset.motion.path as string)];

        const modelFileMap = await this.fetchPresetFileMap(modelFiles);
        const motionFileMap = await this.fetchPresetFileMap(motionFiles);
        const mergedFileMap = this.smplMotionService.mergeDroppedFileMaps(modelFileMap, motionFileMap);

        const preferredModelPath =
          preset.model.selectedUrdfPath ??
          (preset.model.urdfPath ? normalizePresetMapPath(preset.model.urdfPath) : undefined);
        if (preferredModelPath && !mergedFileMap.has(preferredModelPath)) {
          throw new Error(
            `Preset "${preset.label}" selected model path is missing: ${preferredModelPath}`,
          );
        }

        const preferredMotionPath =
          preset.motion.selectedMotionPath ??
          (preset.motion.path ? normalizePresetMapPath(preset.motion.path) : undefined);
        if (preferredMotionPath && !mergedFileMap.has(preferredMotionPath)) {
          throw new Error(
            `Preset "${preset.label}" selected motion path is missing: ${preferredMotionPath}`,
          );
        }

        await this.loadSmplMotionFromDroppedFiles(
          mergedFileMap,
          preferredModelPath,
          preferredMotionPath,
        );

        if (
          this.currentMotionKind !== 'smpl' ||
          !this.currentSmplMotion ||
          !mergedFileMap.has(this.currentSmplMotion.motionSourcePath)
        ) {
          throw new Error(`Failed to load SMPL motion for preset "${preset.label}".`);
        }

        return;
      }

      if (preset.model) {
        if (preset.model.files && preset.model.files.length > 0) {
          const modelFileMap = await this.fetchPresetFileMap(preset.model.files);
          const urdfPaths = this.urdfLoadService.getAvailableUrdfPaths(modelFileMap);
          if (urdfPaths.length === 0) {
            throw new Error(`Preset "${preset.label}" does not contain any URDF file.`);
          }

          const selectedUrdfPath = preset.model.selectedUrdfPath ?? urdfPaths[0];
          if (!selectedUrdfPath || !modelFileMap.has(selectedUrdfPath)) {
            throw new Error(
              `Preset "${preset.label}" selectedUrdfPath is missing: ${preset.model.selectedUrdfPath ?? ''}`,
            );
          }

          this.registerDroppedUrdfFiles(modelFileMap);
          this.availableUrdfPaths = mergeUniquePaths(this.getMergedUrdfModelPaths(), urdfPaths);
          this.selectedUrdfPath = selectedUrdfPath;
          this.renderUrdfList();
          await this.loadSelectedUrdf(selectedUrdfPath);

          if (
            !this.lastLoadResult ||
            !modelFileMap.has(this.lastLoadResult.selectedUrdfPath)
          ) {
            throw new Error(`Failed to load URDF for preset "${preset.label}".`);
          }
        } else {
          const selectedUrdfPath = preset.model.selectedUrdfPath ?? preset.model.urdfPath;
          if (!selectedUrdfPath) {
            throw new Error(`Preset "${preset.label}" does not define model urdfPath.`);
          }

          this.droppedFileMap = null;
          this.availableUrdfPaths = mergeUniquePaths(
            this.getMergedUrdfModelPaths(),
            [selectedUrdfPath],
          );
          this.selectedUrdfPath = selectedUrdfPath;
          this.renderUrdfList();
          await this.loadSelectedUrdf(selectedUrdfPath);

          if (
            !this.lastLoadResult ||
            this.lastLoadResult.selectedUrdfPath !== selectedUrdfPath
          ) {
            throw new Error(`Failed to load URDF for preset "${preset.label}".`);
          }
        }
      }

      if (preset.motion) {
        if ((!preset.motion.files || preset.motion.files.length === 0) && !preset.motion.path) {
          throw new Error(`Preset "${preset.label}" does not define motion files.`);
        }

        const motionFiles =
          preset.motion.files && preset.motion.files.length > 0
            ? preset.motion.files
            : [this.buildSinglePresetFile(preset.motion.path as string)];
        const motionFileMap = await this.fetchPresetFileMap(motionFiles);
        const preferredMotionPath =
          preset.motion.selectedMotionPath ??
          (preset.motion.path ? normalizePresetMapPath(preset.motion.path) : undefined);
        if (preferredMotionPath && !motionFileMap.has(preferredMotionPath)) {
          throw new Error(
            `Preset "${preset.label}" selectedMotionPath is missing: ${preferredMotionPath}`,
          );
        }

        if (preset.motion.kind === 'csv') {
          await this.loadMotionFromDroppedFiles(motionFileMap, preferredMotionPath);

          if (
            this.currentMotionKind !== 'csv' ||
            !this.currentMotionSourcePath ||
            !motionFileMap.has(this.currentMotionSourcePath)
          ) {
            throw new Error(`Failed to load CSV motion for preset "${preset.label}".`);
          }
        } else if (preset.motion.kind === 'mimickit') {
          await this.loadMimicKitMotionFromDroppedFiles(motionFileMap, preferredMotionPath);

          if (
            this.currentMotionKind !== 'mimickit' ||
            !this.currentMotionSourcePath ||
            !motionFileMap.has(this.currentMotionSourcePath)
          ) {
            throw new Error(`Failed to load MimicKit motion for preset "${preset.label}".`);
          }
        } else {
          await this.loadBvhMotionFromDroppedFiles(motionFileMap, preferredMotionPath);

          if (
            this.currentMotionKind !== 'bvh' ||
            !this.currentMotionSourcePath ||
            !motionFileMap.has(this.currentMotionSourcePath)
          ) {
            throw new Error(`Failed to load BVH motion for preset "${preset.label}".`);
          }
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setState('error', {
        title: 'Preset Load Failed',
        detail: reason,
        dropHint:
          'Choose another preset, or drag URDF/CSV/MimicKit PKL/BVH/SMPL model NPZ|PKL + motion NPZ/OBJ files to continue.',
      });
    } finally {
      this.isPresetLoading = false;
      this.syncPresetControls();
    }
  }

  private renderUrdfList(): void {
    const modelOptions = this.getAvailableModelOptions();
    const selectedModelKey = this.getCurrentModelOptionKey(modelOptions);

    this.urdfSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = modelOptions.length > 0 ? 'Select model...' : 'No models available';
    this.urdfSelect.appendChild(placeholder);

    for (const modelOption of modelOptions) {
      const option = document.createElement('option');
      option.value = modelOption.key;
      option.textContent = modelOption.label;
      option.title = modelOption.description || modelOption.path;
      this.urdfSelect.appendChild(option);
    }

    if (selectedModelKey && modelOptions.some((option) => option.key === selectedModelKey)) {
      this.urdfSelect.value = selectedModelKey;
    } else {
      this.urdfSelect.value = '';
    }

    this.urdfSelect.disabled = this.isPresetLoading || modelOptions.length === 0;
    this.renderPresetOptions();
    this.renderObjOptions();
    this.syncPresetControls();
  }

  private renderSmplModelList(): void {
    const previousValue = this.smplModelSelect.value;
    const hasModels = this.availableSmplModelPaths.length > 0;

    this.smplModelSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = hasModels ? 'Select SMPL model...' : 'No SMPL model loaded';
    this.smplModelSelect.appendChild(placeholder);

    for (const smplModelPath of this.availableSmplModelPaths) {
      const option = document.createElement('option');
      option.value = smplModelPath;
      option.textContent = formatSmplModelLabel(smplModelPath);
      option.title = smplModelPath;
      this.smplModelSelect.appendChild(option);
    }

    if (this.selectedSmplModelPath && this.availableSmplModelPaths.includes(this.selectedSmplModelPath)) {
      this.smplModelSelect.value = this.selectedSmplModelPath;
    } else if (this.availableSmplModelPaths.includes(previousValue)) {
      this.smplModelSelect.value = previousValue;
    } else {
      this.smplModelSelect.value = '';
    }

    this.smplModelSelect.disabled = this.availableSmplModelPaths.length === 0;
  }

  private readonly onJointPanelToggleClick = (): void => {
    this.isJointPanelCollapsed = !this.isJointPanelCollapsed;
    this.syncJointPanelCollapsedState();
  };

  private syncJointPanelCollapsedState(): void {
    this.jointPanel.dataset.collapsed = this.isJointPanelCollapsed ? 'true' : 'false';
    this.jointPanelToggle.textContent = this.isJointPanelCollapsed ? '+' : '−';
  }

  private readonly onInsertKeyframeClick = (): void => {
    const currentFrame = this.motionPlayer.getCurrentFrame();
    if (this.keyframes.has(currentFrame)) {
      this.keyframes.delete(currentFrame);
    } else {
      this.keyframes.add(currentFrame);
    }
    this.updateKeyframeMarkers();
  };

  private readonly onPrevKeyframeClick = (): void => {
    if (!this.hasAnyMotion()) {
      return;
    }

    const currentFrame = this.motionPlayer.getCurrentFrame();
    const keyframeArray = Array.from(this.keyframes).sort((a, b) => a - b);
    
    // 找到当前帧之前的最后一个关键帧
    let prevKeyframe = -1;
    for (let i = keyframeArray.length - 1; i >= 0; i--) {
      if (keyframeArray[i] < currentFrame) {
        prevKeyframe = keyframeArray[i];
        break;
      }
    }
    
    // 如果没有找到前一个关键帧，循环到最后一个关键帧
    if (prevKeyframe === -1 && keyframeArray.length > 0) {
      prevKeyframe = keyframeArray[keyframeArray.length - 1];
    }
    
    if (prevKeyframe !== -1) {
      this.motionPlayer.seek(prevKeyframe);
    }
  };

  private readonly onNextKeyframeClick = (): void => {
    if (!this.hasAnyMotion()) {
      return;
    }

    const currentFrame = this.motionPlayer.getCurrentFrame();
    const keyframeArray = Array.from(this.keyframes).sort((a, b) => a - b);
    
    // 找到当前帧之后的第一个关键帧
    let nextKeyframe = -1;
    for (const frame of keyframeArray) {
      if (frame > currentFrame) {
        nextKeyframe = frame;
        break;
      }
    }
    
    // 如果没有找到下一个关键帧，循环到第一个关键帧
    if (nextKeyframe === -1 && keyframeArray.length > 0) {
      nextKeyframe = keyframeArray[0];
    }
    
    if (nextKeyframe !== -1) {
      this.motionPlayer.seek(nextKeyframe);
    }
  };

  private readonly onMotionFrameCountChange = (): void => {
    const newFrameCount = parseInt(this.motionFrameCountInput.value, 10);
    if (!isNaN(newFrameCount) && newFrameCount >= 2) {
      this.motionPlayer.setFrameCount(newFrameCount);
      this.syncMotionControls();
      this.updateKeyframeMarkers();
    }
  };

  private updateKeyframeMarkers(): void {
    if (!this.keyframeMarkersContainer) {
      this.keyframeMarkersContainer = document.getElementById('keyframe-markers');
    }
    if (!this.keyframeMarkersContainer) {
      return;
    }

    this.keyframeMarkersContainer.innerHTML = '';
    const frameCount = this.motionPlayer.getFrameCount();
    if (frameCount <= 0) {
      return;
    }

    // 计算进度条的实际宽度，确保关键帧标记与进度条对齐
    const sliderElement = document.getElementById('motion-frame-slider');
    const sliderWidth = sliderElement ? sliderElement.offsetWidth : this.keyframeMarkersContainer.offsetWidth;
    
    this.keyframes.forEach(frameIndex => {
      const marker = document.createElement('div');
      marker.style.position = 'absolute';
      marker.style.top = '0';
      
      // 计算精确的位置，确保与进度条滑块对齐
      const maxFrame = Math.max(frameCount - 1, 0);
      const positionPercentage = maxFrame > 0 ? (frameIndex / maxFrame) * 100 : 0;
      marker.style.left = `${positionPercentage}%`;
      marker.style.transform = 'translateX(-50%)';
      marker.style.width = '4px';
      marker.style.height = '100%';
      marker.style.backgroundColor = '#53bf9d';
      marker.style.borderRadius = '2px';
      marker.style.cursor = 'pointer';
      marker.title = `Keyframe at frame ${frameIndex}`;
      marker.addEventListener('click', () => {
        this.motionPlayer.seek(frameIndex);
      });
      if (this.keyframeMarkersContainer) {
        this.keyframeMarkersContainer.appendChild(marker);
      }
    });
  }

  private readonly onExportMotionClick = (): void => {
    console.log('Export button clicked!');
    console.log('Current motion kind:', this.currentMotionKind);
    
    if (!isUrdfMotionKind(this.currentMotionKind)) {
      console.log('Not a URDF motion kind');
      return;
    }

    const clip = this.motionPlayer.getClip();
    console.log('Clip:', clip);
    
    if (!clip) {
      console.log('No clip available');
      return;
    }

    this.exportMotionClip(clip);
  };

  private getRobotHeight(): number {
    console.log('getRobotHeight called');
    if (!this.lastLoadResult?.robot) {
      console.log('No robot found in lastLoadResult');
      return 0;
    }

    try {
      // 计算机器人边界框
      const robot = this.lastLoadResult.robot;
      console.log('Robot found:', robot);
      
      const box = this.sceneController['computeRobotBounds'](robot);
      if (!box) {
        console.log('No bounding box found');
        return 0;
      }

      console.log('Bounding box min:', box.min);
      console.log('Bounding box max:', box.max);
      
      // 获取地面位置（机器人最低点）
      const groundPosition = box.min.y;
      console.log('Ground position (box.min.y):', groundPosition);
      
      // 计算root关节的位置
      // 首先尝试从robot对象中获取root关节
      const robotAny = robot as any;
      let rootYPosition = 0;
      
      // 尝试不同的方式获取root关节位置
      if (robotAny.joints && robotAny.joints['floating_base_joint']) {
        const rootJoint = robotAny.joints['floating_base_joint'];
        if (rootJoint.position) {
          rootYPosition = rootJoint.position.y;
          console.log('Root joint position from joints.floating_base_joint:', rootYPosition);
        }
      } else if (robotAny.position) {
        rootYPosition = robotAny.position.y;
        console.log('Root joint position from robot.position:', rootYPosition);
      } else {
        // 如果无法获取root位置，使用边界框中心
        // 创建一个临时对象来存储中心位置
        const center = { y: 0 };
        // 模拟getCenter方法的行为
        center.y = (box.min.y + box.max.y) / 2;
        rootYPosition = center.y;
        console.log('Root joint position from bounding box center:', rootYPosition);
      }
      
      // 计算root关节到地面的高度
      const rootHeight = rootYPosition - groundPosition;
      console.log('Calculated root height:', rootHeight);
      
      return rootHeight;
    } catch (error) {
      console.error('Error calculating robot height:', error);
      return 0;
    }
  }

  private exportMotionClip(clip: any): void {
    let content: string;
    let fileName: string;
    let mimeType: string;

    if (this.currentMotionKind === 'csv') {
      console.log('Generating CSV content');
      const robotHeight = this.getRobotHeight();
      const csvContent = this.csvMotionService.toCsv(clip, robotHeight);
      console.log('CSV content generated, length:', csvContent.length);
      content = csvContent;
      fileName = 'modified_motion.csv';
      mimeType = 'text/csv;charset=utf-8';
    } else if (this.currentMotionKind === 'gmr') {
      console.log('Generating GMR PKL content');
      const pklContent = this.gmrMotionService.toGmrPkl(clip);
      console.log('PKL content generated, length:', pklContent.length);
      content = pklContent;
      fileName = 'modified_motion.pkl';
      mimeType = 'application/octet-stream';
    } else if (this.currentMotionKind === 'mimickit') {
      console.log('Generating MimicKit PKL content');
      const pklContent = this.mimicKitMotionService.toMimicKitPkl(clip);
      console.log('PKL content generated, length:', pklContent.length);
      content = pklContent;
      fileName = 'modified_motion.pkl';
      mimeType = 'application/octet-stream';
    } else {
      console.log('Not a supported motion type for export');
      return;
    }

    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log('File downloaded successfully');
    } catch (error) {
      console.error('Error downloading file:', error);
      alert('下载文件时出错，请查看控制台了解详情。');
    }
  }

  private renderJointPanel(jointNames: string[], jointValues: number[]): void {
    this.jointList.innerHTML = '';

    // 添加Root关节的位置和旋转控制
    this.addRootControls();

    jointNames.forEach((jointName, index) => {
      const jointItem = document.createElement('div');
      jointItem.className = 'joint-item';

      const jointNameSpan = document.createElement('span');
      jointNameSpan.className = 'joint-name';
      jointNameSpan.textContent = jointName;

      const jointInput = document.createElement('input');
      jointInput.className = 'joint-input';
      jointInput.type = 'number';
      jointInput.step = '0.01';
      jointInput.value = jointValues[index].toFixed(4);
      jointInput.dataset.jointName = jointName;

      jointInput.addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        const value = parseFloat(target.value);
        if (!isNaN(value)) {
          this.motionPlayer.setJointValue(jointName, value);
        }
      });

      const jointSlider = document.createElement('input');
      jointSlider.className = 'joint-slider';
      jointSlider.type = 'range';
      jointSlider.min = '-3.14';
      jointSlider.max = '3.14';
      jointSlider.step = '0.01';
      jointSlider.value = jointValues[index].toString();
      jointSlider.dataset.jointName = jointName;

      jointSlider.addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        const value = parseFloat(target.value);
        if (!isNaN(value)) {
          this.motionPlayer.setJointValue(jointName, value);
        }
      });

      // Add smooth controls
      const smoothControls = document.createElement('div');
      smoothControls.className = 'smooth-controls';

      const beforeWrapper = document.createElement('div');
      beforeWrapper.className = 'smooth-slider-wrapper';

      const smoothBeforeSlider = document.createElement('input');
      smoothBeforeSlider.className = 'smooth-slider';
      smoothBeforeSlider.type = 'range';
      smoothBeforeSlider.min = '0';
      smoothBeforeSlider.max = '200';
      smoothBeforeSlider.step = '1';
      smoothBeforeSlider.value = '5';
      smoothBeforeSlider.dataset.jointName = jointName;
      smoothBeforeSlider.title = 'Frames before';

      const beforeValue = document.createElement('span');
      beforeValue.className = 'smooth-slider-value';
      beforeValue.textContent = '5';
      beforeValue.dataset.jointName = jointName;

      smoothBeforeSlider.addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        beforeValue.textContent = target.value;
      });

      beforeWrapper.appendChild(smoothBeforeSlider);
      beforeWrapper.appendChild(beforeValue);

      const afterWrapper = document.createElement('div');
      afterWrapper.className = 'smooth-slider-wrapper';

      const smoothAfterSlider = document.createElement('input');
      smoothAfterSlider.className = 'smooth-slider';
      smoothAfterSlider.type = 'range';
      smoothAfterSlider.min = '0';
      smoothAfterSlider.max = '200';
      smoothAfterSlider.step = '1';
      smoothAfterSlider.value = '5';
      smoothAfterSlider.dataset.jointName = jointName;
      smoothAfterSlider.title = 'Frames after';

      const afterValue = document.createElement('span');
      afterValue.className = 'smooth-slider-value';
      afterValue.textContent = '5';
      afterValue.dataset.jointName = jointName;

      smoothAfterSlider.addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        afterValue.textContent = target.value;
      });

      afterWrapper.appendChild(smoothAfterSlider);
      afterWrapper.appendChild(afterValue);

      const smoothButton = document.createElement('button');
      smoothButton.className = 'smooth-button';
      smoothButton.textContent = 'Smooth';
      smoothButton.dataset.jointName = jointName;

      smoothButton.addEventListener('click', (event) => {
        const target = event.currentTarget as HTMLButtonElement;
        const jointName = target.dataset.jointName;
        if (!jointName) return;

        const beforeSlider = document.querySelector(`.smooth-slider[data-joint-name="${jointName}"]`) as HTMLInputElement;
        const afterSlider = document.querySelectorAll(`.smooth-slider[data-joint-name="${jointName}"]`)[1] as HTMLInputElement;
        if (!beforeSlider || !afterSlider) return;

        const framesBefore = parseInt(beforeSlider.value, 10);
        const framesAfter = parseInt(afterSlider.value, 10);
        const currentFrame = this.motionPlayer.getCurrentFrame();

        // 添加点击反馈效果
        target.classList.add('smooth-button-active');
        target.textContent = 'Smoothing...';

        // 执行平滑操作
        this.motionPlayer.smoothJoint(jointName, currentFrame, framesBefore, framesAfter, Array.from(this.keyframes));

        // 短暂延迟后恢复按钮状态
        setTimeout(() => {
          target.classList.remove('smooth-button-active');
          target.textContent = 'Smooth';
        }, 1000);
      });

      smoothControls.appendChild(beforeWrapper);
      smoothControls.appendChild(afterWrapper);
      smoothControls.appendChild(smoothButton);

      jointItem.appendChild(jointNameSpan);
      jointItem.appendChild(jointInput);
      jointItem.appendChild(jointSlider);
      jointItem.appendChild(smoothControls);
      this.jointList.appendChild(jointItem);
    });
  }

  private addRootControls(): void {
    // 获取当前root位置和旋转
    const rootPos = this.motionPlayer.getRootPosition();
    const rootRot = this.motionPlayer.getRootRotation();

    // 四元数转欧拉角
    function quaternionToEuler(x: number, y: number, z: number, w: number): { roll: number; pitch: number; yaw: number } {
      const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
      const pitch = Math.asin(2 * (w * y - z * x));
      const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
      return { roll, pitch, yaw };
    }

    // 欧拉角转四元数
    function eulerToQuaternion(roll: number, pitch: number, yaw: number): { x: number; y: number; z: number; w: number } {
      const cy = Math.cos(yaw * 0.5);
      const sy = Math.sin(yaw * 0.5);
      const cp = Math.cos(pitch * 0.5);
      const sp = Math.sin(pitch * 0.5);
      const cr = Math.cos(roll * 0.5);
      const sr = Math.sin(roll * 0.5);

      return {
        w: cy * cp * cr + sy * sp * sr,
        x: cy * cp * sr - sy * sp * cr,
        y: sy * cp * sr + cy * sp * cr,
        z: sy * cp * cr - cy * sp * sr
      };
    }

    const euler = quaternionToEuler(rootRot.x, rootRot.y, rootRot.z, rootRot.w);

    // 创建Root位置控制 - X
    const rootPosXItem = document.createElement('div');
    rootPosXItem.className = 'joint-item';
    rootPosXItem.style.backgroundColor = 'rgba(83, 191, 157, 0.1)';

    const rootPosXTitle = document.createElement('span');
    rootPosXTitle.className = 'joint-name';
    rootPosXTitle.style.fontWeight = 'bold';
    rootPosXTitle.textContent = 'Root Position X';
    rootPosXItem.appendChild(rootPosXTitle);

    const posXInput = document.createElement('input');
    posXInput.className = 'joint-input';
    posXInput.type = 'number';
    posXInput.step = '0.01';
    posXInput.value = rootPos.x.toFixed(4);
    posXInput.dataset.rootControl = 'position';
    posXInput.dataset.axis = 'x';

    posXInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentPos = this.motionPlayer.getRootPosition();
        this.motionPlayer.setRootPosition(value, currentPos.y, currentPos.z);
        const slider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="position"][data-axis="x"]');
        if (slider) slider.value = value.toString();
      }
    });

    rootPosXItem.appendChild(posXInput);

    const posXSlider = document.createElement('input');
    posXSlider.className = 'joint-slider root-slider';
    posXSlider.type = 'range';
    posXSlider.min = '-10';
    posXSlider.max = '10';
    posXSlider.step = '0.01';
    posXSlider.value = rootPos.x.toString();
    posXSlider.dataset.rootControl = 'position';
    posXSlider.dataset.axis = 'x';

    posXSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentPos = this.motionPlayer.getRootPosition();
        this.motionPlayer.setRootPosition(value, currentPos.y, currentPos.z);
        const input = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="position"][data-axis="x"]');
        if (input) input.value = value.toFixed(4);
      }
    });

    rootPosXItem.appendChild(posXSlider);

    // Add smooth controls for Root Position X
    const smoothControlsX = document.createElement('div');
    smoothControlsX.className = 'smooth-controls';

    const beforeWrapperX = document.createElement('div');
    beforeWrapperX.className = 'smooth-slider-wrapper';

    const smoothBeforeSliderX = document.createElement('input');
    smoothBeforeSliderX.className = 'smooth-slider';
    smoothBeforeSliderX.type = 'range';
    smoothBeforeSliderX.min = '0';
    smoothBeforeSliderX.max = '200';
    smoothBeforeSliderX.step = '1';
    smoothBeforeSliderX.value = '5';
    smoothBeforeSliderX.dataset.rootControl = 'smooth';
    smoothBeforeSliderX.dataset.axis = 'x';
    smoothBeforeSliderX.dataset.direction = 'before';
    smoothBeforeSliderX.title = 'Frames before';

    const beforeValueX = document.createElement('span');
    beforeValueX.className = 'smooth-slider-value';
    beforeValueX.textContent = '5';
    beforeValueX.dataset.rootControl = 'smooth';
    beforeValueX.dataset.axis = 'x';
    beforeValueX.dataset.direction = 'before';

    smoothBeforeSliderX.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      beforeValueX.textContent = target.value;
    });

    beforeWrapperX.appendChild(smoothBeforeSliderX);
    beforeWrapperX.appendChild(beforeValueX);

    const afterWrapperX = document.createElement('div');
    afterWrapperX.className = 'smooth-slider-wrapper';

    const smoothAfterSliderX = document.createElement('input');
    smoothAfterSliderX.className = 'smooth-slider';
    smoothAfterSliderX.type = 'range';
    smoothAfterSliderX.min = '0';
    smoothAfterSliderX.max = '200';
    smoothAfterSliderX.step = '1';
    smoothAfterSliderX.value = '5';
    smoothAfterSliderX.dataset.rootControl = 'smooth';
    smoothAfterSliderX.dataset.axis = 'x';
    smoothAfterSliderX.dataset.direction = 'after';
    smoothAfterSliderX.title = 'Frames after';

    const afterValueX = document.createElement('span');
    afterValueX.className = 'smooth-slider-value';
    afterValueX.textContent = '5';
    afterValueX.dataset.rootControl = 'smooth';
    afterValueX.dataset.axis = 'x';
    afterValueX.dataset.direction = 'after';

    smoothAfterSliderX.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      afterValueX.textContent = target.value;
    });

    afterWrapperX.appendChild(smoothAfterSliderX);
    afterWrapperX.appendChild(afterValueX);

    const smoothButtonX = document.createElement('button');
    smoothButtonX.className = 'smooth-button';
    smoothButtonX.textContent = 'Smooth';
    smoothButtonX.dataset.rootControl = 'smooth';
    smoothButtonX.dataset.axis = 'x';

    smoothButtonX.addEventListener('click', (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const axis = target.dataset.axis;
      if (!axis) return;

      const beforeSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="before"]`) as HTMLInputElement;
      const afterSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="after"]`) as HTMLInputElement;
      if (!beforeSlider || !afterSlider) return;

      const framesBefore = parseInt(beforeSlider.value, 10);
      const framesAfter = parseInt(afterSlider.value, 10);
      const currentFrame = this.motionPlayer.getCurrentFrame();

      // 添加点击反馈效果
      target.classList.add('smooth-button-active');
      target.textContent = 'Smoothing...';

      // 执行平滑操作
      this.smoothRootAxis(axis, currentFrame, framesBefore, framesAfter);

      // 短暂延迟后恢复按钮状态
      setTimeout(() => {
        target.classList.remove('smooth-button-active');
        target.textContent = 'Smooth';
      }, 1000);
    });

    smoothControlsX.appendChild(beforeWrapperX);
    smoothControlsX.appendChild(afterWrapperX);
    smoothControlsX.appendChild(smoothButtonX);

    rootPosXItem.appendChild(smoothControlsX);
    this.jointList.appendChild(rootPosXItem);

    // 创建Root位置控制 - Y
    const rootPosYItem = document.createElement('div');
    rootPosYItem.className = 'joint-item';
    rootPosYItem.style.backgroundColor = 'rgba(83, 191, 157, 0.1)';

    const rootPosYTitle = document.createElement('span');
    rootPosYTitle.className = 'joint-name';
    rootPosYTitle.style.fontWeight = 'bold';
    rootPosYTitle.textContent = 'Root Position Y';
    rootPosYItem.appendChild(rootPosYTitle);

    const posYInput = document.createElement('input');
    posYInput.className = 'joint-input';
    posYInput.type = 'number';
    posYInput.step = '0.01';
    posYInput.value = rootPos.y.toFixed(4);
    posYInput.dataset.rootControl = 'position';
    posYInput.dataset.axis = 'y';

    posYInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentPos = this.motionPlayer.getRootPosition();
        this.motionPlayer.setRootPosition(currentPos.x, value, currentPos.z);
        const slider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="position"][data-axis="y"]');
        if (slider) slider.value = value.toString();
      }
    });

    rootPosYItem.appendChild(posYInput);

    const posYSlider = document.createElement('input');
    posYSlider.className = 'joint-slider root-slider';
    posYSlider.type = 'range';
    posYSlider.min = '-10';
    posYSlider.max = '10';
    posYSlider.step = '0.01';
    posYSlider.value = rootPos.y.toString();
    posYSlider.dataset.rootControl = 'position';
    posYSlider.dataset.axis = 'y';

    posYSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentPos = this.motionPlayer.getRootPosition();
        this.motionPlayer.setRootPosition(currentPos.x, value, currentPos.z);
        const input = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="position"][data-axis="y"]');
        if (input) input.value = value.toFixed(4);
      }
    });

    rootPosYItem.appendChild(posYSlider);

    // Add smooth controls for Root Position Y
    const smoothControlsY = document.createElement('div');
    smoothControlsY.className = 'smooth-controls';

    const beforeWrapperY = document.createElement('div');
    beforeWrapperY.className = 'smooth-slider-wrapper';

    const smoothBeforeSliderY = document.createElement('input');
    smoothBeforeSliderY.className = 'smooth-slider';
    smoothBeforeSliderY.type = 'range';
    smoothBeforeSliderY.min = '0';
    smoothBeforeSliderY.max = '200';
    smoothBeforeSliderY.step = '1';
    smoothBeforeSliderY.value = '5';
    smoothBeforeSliderY.dataset.rootControl = 'smooth';
    smoothBeforeSliderY.dataset.axis = 'y';
    smoothBeforeSliderY.dataset.direction = 'before';
    smoothBeforeSliderY.title = 'Frames before';

    const beforeValueY = document.createElement('span');
    beforeValueY.className = 'smooth-slider-value';
    beforeValueY.textContent = '5';
    beforeValueY.dataset.rootControl = 'smooth';
    beforeValueY.dataset.axis = 'y';
    beforeValueY.dataset.direction = 'before';

    smoothBeforeSliderY.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      beforeValueY.textContent = target.value;
    });

    beforeWrapperY.appendChild(smoothBeforeSliderY);
    beforeWrapperY.appendChild(beforeValueY);

    const afterWrapperY = document.createElement('div');
    afterWrapperY.className = 'smooth-slider-wrapper';

    const smoothAfterSliderY = document.createElement('input');
    smoothAfterSliderY.className = 'smooth-slider';
    smoothAfterSliderY.type = 'range';
    smoothAfterSliderY.min = '0';
    smoothAfterSliderY.max = '200';
    smoothAfterSliderY.step = '1';
    smoothAfterSliderY.value = '5';
    smoothAfterSliderY.dataset.rootControl = 'smooth';
    smoothAfterSliderY.dataset.axis = 'y';
    smoothAfterSliderY.dataset.direction = 'after';
    smoothAfterSliderY.title = 'Frames after';

    const afterValueY = document.createElement('span');
    afterValueY.className = 'smooth-slider-value';
    afterValueY.textContent = '5';
    afterValueY.dataset.rootControl = 'smooth';
    afterValueY.dataset.axis = 'y';
    afterValueY.dataset.direction = 'after';

    smoothAfterSliderY.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      afterValueY.textContent = target.value;
    });

    afterWrapperY.appendChild(smoothAfterSliderY);
    afterWrapperY.appendChild(afterValueY);

    const smoothButtonY = document.createElement('button');
    smoothButtonY.className = 'smooth-button';
    smoothButtonY.textContent = 'Smooth';
    smoothButtonY.dataset.rootControl = 'smooth';
    smoothButtonY.dataset.axis = 'y';

    smoothButtonY.addEventListener('click', (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const axis = target.dataset.axis;
      if (!axis) return;

      const beforeSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="before"]`) as HTMLInputElement;
      const afterSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="after"]`) as HTMLInputElement;
      if (!beforeSlider || !afterSlider) return;

      const framesBefore = parseInt(beforeSlider.value, 10);
      const framesAfter = parseInt(afterSlider.value, 10);
      const currentFrame = this.motionPlayer.getCurrentFrame();

      // 添加点击反馈效果
      target.classList.add('smooth-button-active');
      target.textContent = 'Smoothing...';

      // 执行平滑操作
      this.smoothRootAxis(axis, currentFrame, framesBefore, framesAfter);

      // 短暂延迟后恢复按钮状态
      setTimeout(() => {
        target.classList.remove('smooth-button-active');
        target.textContent = 'Smooth';
      }, 1000);
    });

    smoothControlsY.appendChild(beforeWrapperY);
    smoothControlsY.appendChild(afterWrapperY);
    smoothControlsY.appendChild(smoothButtonY);

    rootPosYItem.appendChild(smoothControlsY);
    this.jointList.appendChild(rootPosYItem);

    // 创建Root位置控制 - Z
    const rootPosZItem = document.createElement('div');
    rootPosZItem.className = 'joint-item';
    rootPosZItem.style.backgroundColor = 'rgba(83, 191, 157, 0.1)';

    const rootPosZTitle = document.createElement('span');
    rootPosZTitle.className = 'joint-name';
    rootPosZTitle.style.fontWeight = 'bold';
    rootPosZTitle.textContent = 'Root Position Z';
    rootPosZItem.appendChild(rootPosZTitle);

    const posZInput = document.createElement('input');
    posZInput.className = 'joint-input';
    posZInput.type = 'number';
    posZInput.step = '0.01';
    posZInput.value = rootPos.z.toFixed(4);
    posZInput.dataset.rootControl = 'position';
    posZInput.dataset.axis = 'z';

    posZInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentPos = this.motionPlayer.getRootPosition();
        this.motionPlayer.setRootPosition(currentPos.x, currentPos.y, value);
        const slider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="position"][data-axis="z"]');
        if (slider) slider.value = value.toString();
      }
    });

    rootPosZItem.appendChild(posZInput);

    const posZSlider = document.createElement('input');
    posZSlider.className = 'joint-slider root-slider';
    posZSlider.type = 'range';
    posZSlider.min = '-10';
    posZSlider.max = '10';
    posZSlider.step = '0.01';
    posZSlider.value = rootPos.z.toString();
    posZSlider.dataset.rootControl = 'position';
    posZSlider.dataset.axis = 'z';

    posZSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentPos = this.motionPlayer.getRootPosition();
        this.motionPlayer.setRootPosition(currentPos.x, currentPos.y, value);
        const input = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="position"][data-axis="z"]');
        if (input) input.value = value.toFixed(4);
      }
    });

    rootPosZItem.appendChild(posZSlider);

    // Add smooth controls for Root Position Z
    const smoothControlsZ = document.createElement('div');
    smoothControlsZ.className = 'smooth-controls';

    const beforeWrapperZ = document.createElement('div');
    beforeWrapperZ.className = 'smooth-slider-wrapper';

    const smoothBeforeSliderZ = document.createElement('input');
    smoothBeforeSliderZ.className = 'smooth-slider';
    smoothBeforeSliderZ.type = 'range';
    smoothBeforeSliderZ.min = '0';
    smoothBeforeSliderZ.max = '200';
    smoothBeforeSliderZ.step = '1';
    smoothBeforeSliderZ.value = '5';
    smoothBeforeSliderZ.dataset.rootControl = 'smooth';
    smoothBeforeSliderZ.dataset.axis = 'z';
    smoothBeforeSliderZ.dataset.direction = 'before';
    smoothBeforeSliderZ.title = 'Frames before';

    const beforeValueZ = document.createElement('span');
    beforeValueZ.className = 'smooth-slider-value';
    beforeValueZ.textContent = '5';
    beforeValueZ.dataset.rootControl = 'smooth';
    beforeValueZ.dataset.axis = 'z';
    beforeValueZ.dataset.direction = 'before';

    smoothBeforeSliderZ.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      beforeValueZ.textContent = target.value;
    });

    beforeWrapperZ.appendChild(smoothBeforeSliderZ);
    beforeWrapperZ.appendChild(beforeValueZ);

    const afterWrapperZ = document.createElement('div');
    afterWrapperZ.className = 'smooth-slider-wrapper';

    const smoothAfterSliderZ = document.createElement('input');
    smoothAfterSliderZ.className = 'smooth-slider';
    smoothAfterSliderZ.type = 'range';
    smoothAfterSliderZ.min = '0';
    smoothAfterSliderZ.max = '200';
    smoothAfterSliderZ.step = '1';
    smoothAfterSliderZ.value = '5';
    smoothAfterSliderZ.dataset.rootControl = 'smooth';
    smoothAfterSliderZ.dataset.axis = 'z';
    smoothAfterSliderZ.dataset.direction = 'after';
    smoothAfterSliderZ.title = 'Frames after';

    const afterValueZ = document.createElement('span');
    afterValueZ.className = 'smooth-slider-value';
    afterValueZ.textContent = '5';
    afterValueZ.dataset.rootControl = 'smooth';
    afterValueZ.dataset.axis = 'z';
    afterValueZ.dataset.direction = 'after';

    smoothAfterSliderZ.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      afterValueZ.textContent = target.value;
    });

    afterWrapperZ.appendChild(smoothAfterSliderZ);
    afterWrapperZ.appendChild(afterValueZ);

    const smoothButtonZ = document.createElement('button');
    smoothButtonZ.className = 'smooth-button';
    smoothButtonZ.textContent = 'Smooth';
    smoothButtonZ.dataset.rootControl = 'smooth';
    smoothButtonZ.dataset.axis = 'z';

    smoothButtonZ.addEventListener('click', (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const axis = target.dataset.axis;
      if (!axis) return;

      const beforeSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="before"]`) as HTMLInputElement;
      const afterSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="after"]`) as HTMLInputElement;
      if (!beforeSlider || !afterSlider) return;

      const framesBefore = parseInt(beforeSlider.value, 10);
      const framesAfter = parseInt(afterSlider.value, 10);
      const currentFrame = this.motionPlayer.getCurrentFrame();

      // 添加点击反馈效果
      target.classList.add('smooth-button-active');
      target.textContent = 'Smoothing...';

      // 执行平滑操作
      this.smoothRootAxis(axis, currentFrame, framesBefore, framesAfter);

      // 短暂延迟后恢复按钮状态
      setTimeout(() => {
        target.classList.remove('smooth-button-active');
        target.textContent = 'Smooth';
      }, 1000);
    });

    smoothControlsZ.appendChild(beforeWrapperZ);
    smoothControlsZ.appendChild(afterWrapperZ);
    smoothControlsZ.appendChild(smoothButtonZ);

    rootPosZItem.appendChild(smoothControlsZ);
    this.jointList.appendChild(rootPosZItem);

    // 创建Root旋转控制 - 欧拉角Roll
    const rootRotRollItem = document.createElement('div');
    rootRotRollItem.className = 'joint-item';
    rootRotRollItem.style.backgroundColor = 'rgba(83, 191, 157, 0.1)';

    const rootRotRollTitle = document.createElement('span');
    rootRotRollTitle.className = 'joint-name';
    rootRotRollTitle.style.fontWeight = 'bold';
    rootRotRollTitle.textContent = 'Root Rotation Roll';
    rootRotRollItem.appendChild(rootRotRollTitle);

    const rotRollInput = document.createElement('input');
    rotRollInput.className = 'joint-input';
    rotRollInput.type = 'number';
    rotRollInput.step = '0.01';
    rotRollInput.value = euler.roll.toFixed(4);
    rotRollInput.dataset.rootControl = 'rotation';
    rotRollInput.dataset.axis = 'roll';

    rotRollInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        const quat = eulerToQuaternion(value, currentEuler.pitch, currentEuler.yaw);
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
        const slider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="roll"]');
        if (slider) slider.value = value.toString();
      }
    });

    rootRotRollItem.appendChild(rotRollInput);

    const rotRollSlider = document.createElement('input');
    rotRollSlider.className = 'joint-slider root-slider';
    rotRollSlider.type = 'range';
    rotRollSlider.min = '-3.14';
    rotRollSlider.max = '3.14';
    rotRollSlider.step = '0.01';
    rotRollSlider.value = euler.roll.toString();
    rotRollSlider.dataset.rootControl = 'rotation';
    rotRollSlider.dataset.axis = 'roll';

    rotRollSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        const quat = eulerToQuaternion(value, currentEuler.pitch, currentEuler.yaw);
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
        const input = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="roll"]');
        if (input) input.value = value.toFixed(4);
      }
    });

    rootRotRollItem.appendChild(rotRollSlider);

    // Add smooth controls for Root Rotation Roll
    const smoothControlsRoll = document.createElement('div');
    smoothControlsRoll.className = 'smooth-controls';

    const beforeWrapperRoll = document.createElement('div');
    beforeWrapperRoll.className = 'smooth-slider-wrapper';

    const smoothBeforeSliderRoll = document.createElement('input');
    smoothBeforeSliderRoll.className = 'smooth-slider';
    smoothBeforeSliderRoll.type = 'range';
    smoothBeforeSliderRoll.min = '0';
    smoothBeforeSliderRoll.max = '200';
    smoothBeforeSliderRoll.step = '1';
    smoothBeforeSliderRoll.value = '5';
    smoothBeforeSliderRoll.dataset.rootControl = 'smooth';
    smoothBeforeSliderRoll.dataset.axis = 'roll';
    smoothBeforeSliderRoll.dataset.direction = 'before';
    smoothBeforeSliderRoll.title = 'Frames before';

    const beforeValueRoll = document.createElement('span');
    beforeValueRoll.className = 'smooth-slider-value';
    beforeValueRoll.textContent = '5';
    beforeValueRoll.dataset.rootControl = 'smooth';
    beforeValueRoll.dataset.axis = 'roll';
    beforeValueRoll.dataset.direction = 'before';

    smoothBeforeSliderRoll.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      beforeValueRoll.textContent = target.value;
    });

    beforeWrapperRoll.appendChild(smoothBeforeSliderRoll);
    beforeWrapperRoll.appendChild(beforeValueRoll);

    const afterWrapperRoll = document.createElement('div');
    afterWrapperRoll.className = 'smooth-slider-wrapper';

    const smoothAfterSliderRoll = document.createElement('input');
    smoothAfterSliderRoll.className = 'smooth-slider';
    smoothAfterSliderRoll.type = 'range';
    smoothAfterSliderRoll.min = '0';
    smoothAfterSliderRoll.max = '200';
    smoothAfterSliderRoll.step = '1';
    smoothAfterSliderRoll.value = '5';
    smoothAfterSliderRoll.dataset.rootControl = 'smooth';
    smoothAfterSliderRoll.dataset.axis = 'roll';
    smoothAfterSliderRoll.dataset.direction = 'after';
    smoothAfterSliderRoll.title = 'Frames after';

    const afterValueRoll = document.createElement('span');
    afterValueRoll.className = 'smooth-slider-value';
    afterValueRoll.textContent = '5';
    afterValueRoll.dataset.rootControl = 'smooth';
    afterValueRoll.dataset.axis = 'roll';
    afterValueRoll.dataset.direction = 'after';

    smoothAfterSliderRoll.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      afterValueRoll.textContent = target.value;
    });

    afterWrapperRoll.appendChild(smoothAfterSliderRoll);
    afterWrapperRoll.appendChild(afterValueRoll);

    const smoothButtonRoll = document.createElement('button');
    smoothButtonRoll.className = 'smooth-button';
    smoothButtonRoll.textContent = 'Smooth';
    smoothButtonRoll.dataset.rootControl = 'smooth';
    smoothButtonRoll.dataset.axis = 'roll';

    smoothButtonRoll.addEventListener('click', (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const axis = target.dataset.axis;
      if (!axis) return;

      const beforeSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="before"]`) as HTMLInputElement;
      const afterSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="after"]`) as HTMLInputElement;
      if (!beforeSlider || !afterSlider) return;

      const framesBefore = parseInt(beforeSlider.value, 10);
      const framesAfter = parseInt(afterSlider.value, 10);
      const currentFrame = this.motionPlayer.getCurrentFrame();

      // 添加点击反馈效果
      target.classList.add('smooth-button-active');
      target.textContent = 'Smoothing...';

      // 执行平滑操作
      this.smoothRootAxis(axis, currentFrame, framesBefore, framesAfter);

      // 短暂延迟后恢复按钮状态
      setTimeout(() => {
        target.classList.remove('smooth-button-active');
        target.textContent = 'Smooth';
      }, 1000);
    });

    smoothControlsRoll.appendChild(beforeWrapperRoll);
    smoothControlsRoll.appendChild(afterWrapperRoll);
    smoothControlsRoll.appendChild(smoothButtonRoll);

    rootRotRollItem.appendChild(smoothControlsRoll);
    this.jointList.appendChild(rootRotRollItem);

    // 创建Root旋转控制 - 欧拉角Pitch
    const rootRotPitchItem = document.createElement('div');
    rootRotPitchItem.className = 'joint-item';
    rootRotPitchItem.style.backgroundColor = 'rgba(83, 191, 157, 0.1)';

    const rootRotPitchTitle = document.createElement('span');
    rootRotPitchTitle.className = 'joint-name';
    rootRotPitchTitle.style.fontWeight = 'bold';
    rootRotPitchTitle.textContent = 'Root Rotation Pitch';
    rootRotPitchItem.appendChild(rootRotPitchTitle);

    const rotPitchInput = document.createElement('input');
    rotPitchInput.className = 'joint-input';
    rotPitchInput.type = 'number';
    rotPitchInput.step = '0.01';
    rotPitchInput.value = euler.pitch.toFixed(4);
    rotPitchInput.dataset.rootControl = 'rotation';
    rotPitchInput.dataset.axis = 'pitch';

    rotPitchInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        const quat = eulerToQuaternion(currentEuler.roll, value, currentEuler.yaw);
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
        const slider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="pitch"]');
        if (slider) slider.value = value.toString();
      }
    });

    rootRotPitchItem.appendChild(rotPitchInput);

    const rotPitchSlider = document.createElement('input');
    rotPitchSlider.className = 'joint-slider root-slider';
    rotPitchSlider.type = 'range';
    rotPitchSlider.min = '-3.14';
    rotPitchSlider.max = '3.14';
    rotPitchSlider.step = '0.01';
    rotPitchSlider.value = euler.pitch.toString();
    rotPitchSlider.dataset.rootControl = 'rotation';
    rotPitchSlider.dataset.axis = 'pitch';

    rotPitchSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        const quat = eulerToQuaternion(currentEuler.roll, value, currentEuler.yaw);
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
        const input = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="pitch"]');
        if (input) input.value = value.toFixed(4);
      }
    });

    rootRotPitchItem.appendChild(rotPitchSlider);

    // Add smooth controls for Root Rotation Pitch
    const smoothControlsPitch = document.createElement('div');
    smoothControlsPitch.className = 'smooth-controls';

    const beforeWrapperPitch = document.createElement('div');
    beforeWrapperPitch.className = 'smooth-slider-wrapper';

    const smoothBeforeSliderPitch = document.createElement('input');
    smoothBeforeSliderPitch.className = 'smooth-slider';
    smoothBeforeSliderPitch.type = 'range';
    smoothBeforeSliderPitch.min = '0';
    smoothBeforeSliderPitch.max = '200';
    smoothBeforeSliderPitch.step = '1';
    smoothBeforeSliderPitch.value = '5';
    smoothBeforeSliderPitch.dataset.rootControl = 'smooth';
    smoothBeforeSliderPitch.dataset.axis = 'pitch';
    smoothBeforeSliderPitch.dataset.direction = 'before';
    smoothBeforeSliderPitch.title = 'Frames before';

    const beforeValuePitch = document.createElement('span');
    beforeValuePitch.className = 'smooth-slider-value';
    beforeValuePitch.textContent = '5';
    beforeValuePitch.dataset.rootControl = 'smooth';
    beforeValuePitch.dataset.axis = 'pitch';
    beforeValuePitch.dataset.direction = 'before';

    smoothBeforeSliderPitch.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      beforeValuePitch.textContent = target.value;
    });

    beforeWrapperPitch.appendChild(smoothBeforeSliderPitch);
    beforeWrapperPitch.appendChild(beforeValuePitch);

    const afterWrapperPitch = document.createElement('div');
    afterWrapperPitch.className = 'smooth-slider-wrapper';

    const smoothAfterSliderPitch = document.createElement('input');
    smoothAfterSliderPitch.className = 'smooth-slider';
    smoothAfterSliderPitch.type = 'range';
    smoothAfterSliderPitch.min = '0';
    smoothAfterSliderPitch.max = '200';
    smoothAfterSliderPitch.step = '1';
    smoothAfterSliderPitch.value = '5';
    smoothAfterSliderPitch.dataset.rootControl = 'smooth';
    smoothAfterSliderPitch.dataset.axis = 'pitch';
    smoothAfterSliderPitch.dataset.direction = 'after';
    smoothAfterSliderPitch.title = 'Frames after';

    const afterValuePitch = document.createElement('span');
    afterValuePitch.className = 'smooth-slider-value';
    afterValuePitch.textContent = '5';
    afterValuePitch.dataset.rootControl = 'smooth';
    afterValuePitch.dataset.axis = 'pitch';
    afterValuePitch.dataset.direction = 'after';

    smoothAfterSliderPitch.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      afterValuePitch.textContent = target.value;
    });

    afterWrapperPitch.appendChild(smoothAfterSliderPitch);
    afterWrapperPitch.appendChild(afterValuePitch);

    const smoothButtonPitch = document.createElement('button');
    smoothButtonPitch.className = 'smooth-button';
    smoothButtonPitch.textContent = 'Smooth';
    smoothButtonPitch.dataset.rootControl = 'smooth';
    smoothButtonPitch.dataset.axis = 'pitch';

    smoothButtonPitch.addEventListener('click', (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const axis = target.dataset.axis;
      if (!axis) return;

      const beforeSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="before"]`) as HTMLInputElement;
      const afterSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="after"]`) as HTMLInputElement;
      if (!beforeSlider || !afterSlider) return;

      const framesBefore = parseInt(beforeSlider.value, 10);
      const framesAfter = parseInt(afterSlider.value, 10);
      const currentFrame = this.motionPlayer.getCurrentFrame();

      // 添加点击反馈效果
      target.classList.add('smooth-button-active');
      target.textContent = 'Smoothing...';

      // 执行平滑操作
      this.smoothRootAxis(axis, currentFrame, framesBefore, framesAfter);

      // 短暂延迟后恢复按钮状态
      setTimeout(() => {
        target.classList.remove('smooth-button-active');
        target.textContent = 'Smooth';
      }, 1000);
    });

    smoothControlsPitch.appendChild(beforeWrapperPitch);
    smoothControlsPitch.appendChild(afterWrapperPitch);
    smoothControlsPitch.appendChild(smoothButtonPitch);

    rootRotPitchItem.appendChild(smoothControlsPitch);
    this.jointList.appendChild(rootRotPitchItem);

    // 创建Root旋转控制 - 欧拉角Yaw
    const rootRotYawItem = document.createElement('div');
    rootRotYawItem.className = 'joint-item';
    rootRotYawItem.style.backgroundColor = 'rgba(83, 191, 157, 0.1)';

    const rootRotYawTitle = document.createElement('span');
    rootRotYawTitle.className = 'joint-name';
    rootRotYawTitle.style.fontWeight = 'bold';
    rootRotYawTitle.textContent = 'Root Rotation Yaw';
    rootRotYawItem.appendChild(rootRotYawTitle);

    const rotYawInput = document.createElement('input');
    rotYawInput.className = 'joint-input';
    rotYawInput.type = 'number';
    rotYawInput.step = '0.01';
    rotYawInput.value = euler.yaw.toFixed(4);
    rotYawInput.dataset.rootControl = 'rotation';
    rotYawInput.dataset.axis = 'yaw';

    rotYawInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        const quat = eulerToQuaternion(currentEuler.roll, currentEuler.pitch, value);
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
        const slider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="yaw"]');
        if (slider) slider.value = value.toString();
      }
    });

    rootRotYawItem.appendChild(rotYawInput);

    const rotYawSlider = document.createElement('input');
    rotYawSlider.className = 'joint-slider root-slider';
    rotYawSlider.type = 'range';
    rotYawSlider.min = '-3.14';
    rotYawSlider.max = '3.14';
    rotYawSlider.step = '0.01';
    rotYawSlider.value = euler.yaw.toString();
    rotYawSlider.dataset.rootControl = 'rotation';
    rotYawSlider.dataset.axis = 'yaw';

    rotYawSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const value = parseFloat(target.value);
      if (!isNaN(value)) {
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        const quat = eulerToQuaternion(currentEuler.roll, currentEuler.pitch, value);
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
        const input = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="yaw"]');
        if (input) input.value = value.toFixed(4);
      }
    });

    rootRotYawItem.appendChild(rotYawSlider);

    // Add smooth controls for Root Rotation Yaw
    const smoothControlsYaw = document.createElement('div');
    smoothControlsYaw.className = 'smooth-controls';

    const beforeWrapperYaw = document.createElement('div');
    beforeWrapperYaw.className = 'smooth-slider-wrapper';

    const smoothBeforeSliderYaw = document.createElement('input');
    smoothBeforeSliderYaw.className = 'smooth-slider';
    smoothBeforeSliderYaw.type = 'range';
    smoothBeforeSliderYaw.min = '0';
    smoothBeforeSliderYaw.max = '200';
    smoothBeforeSliderYaw.step = '1';
    smoothBeforeSliderYaw.value = '5';
    smoothBeforeSliderYaw.dataset.rootControl = 'smooth';
    smoothBeforeSliderYaw.dataset.axis = 'yaw';
    smoothBeforeSliderYaw.dataset.direction = 'before';
    smoothBeforeSliderYaw.title = 'Frames before';

    const beforeValueYaw = document.createElement('span');
    beforeValueYaw.className = 'smooth-slider-value';
    beforeValueYaw.textContent = '5';
    beforeValueYaw.dataset.rootControl = 'smooth';
    beforeValueYaw.dataset.axis = 'yaw';
    beforeValueYaw.dataset.direction = 'before';

    smoothBeforeSliderYaw.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      beforeValueYaw.textContent = target.value;
    });

    beforeWrapperYaw.appendChild(smoothBeforeSliderYaw);
    beforeWrapperYaw.appendChild(beforeValueYaw);

    const afterWrapperYaw = document.createElement('div');
    afterWrapperYaw.className = 'smooth-slider-wrapper';

    const smoothAfterSliderYaw = document.createElement('input');
    smoothAfterSliderYaw.className = 'smooth-slider';
    smoothAfterSliderYaw.type = 'range';
    smoothAfterSliderYaw.min = '0';
    smoothAfterSliderYaw.max = '200';
    smoothAfterSliderYaw.step = '1';
    smoothAfterSliderYaw.value = '5';
    smoothAfterSliderYaw.dataset.rootControl = 'smooth';
    smoothAfterSliderYaw.dataset.axis = 'yaw';
    smoothAfterSliderYaw.dataset.direction = 'after';
    smoothAfterSliderYaw.title = 'Frames after';

    const afterValueYaw = document.createElement('span');
    afterValueYaw.className = 'smooth-slider-value';
    afterValueYaw.textContent = '5';
    afterValueYaw.dataset.rootControl = 'smooth';
    afterValueYaw.dataset.axis = 'yaw';
    afterValueYaw.dataset.direction = 'after';

    smoothAfterSliderYaw.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      afterValueYaw.textContent = target.value;
    });

    afterWrapperYaw.appendChild(smoothAfterSliderYaw);
    afterWrapperYaw.appendChild(afterValueYaw);

    const smoothButtonYaw = document.createElement('button');
    smoothButtonYaw.className = 'smooth-button';
    smoothButtonYaw.textContent = 'Smooth';
    smoothButtonYaw.dataset.rootControl = 'smooth';
    smoothButtonYaw.dataset.axis = 'yaw';

    smoothButtonYaw.addEventListener('click', (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const axis = target.dataset.axis;
      if (!axis) return;

      const beforeSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="before"]`) as HTMLInputElement;
      const afterSlider = document.querySelector(`.smooth-slider[data-root-control="smooth"][data-axis="${axis}"][data-direction="after"]`) as HTMLInputElement;
      if (!beforeSlider || !afterSlider) return;

      const framesBefore = parseInt(beforeSlider.value, 10);
      const framesAfter = parseInt(afterSlider.value, 10);
      const currentFrame = this.motionPlayer.getCurrentFrame();

      // 添加点击反馈效果
      target.classList.add('smooth-button-active');
      target.textContent = 'Smoothing...';

      // 执行平滑操作
      this.smoothRootAxis(axis, currentFrame, framesBefore, framesAfter);

      // 短暂延迟后恢复按钮状态
      setTimeout(() => {
        target.classList.remove('smooth-button-active');
        target.textContent = 'Smooth';
      }, 1000);
    });

    smoothControlsYaw.appendChild(beforeWrapperYaw);
    smoothControlsYaw.appendChild(afterWrapperYaw);
    smoothControlsYaw.appendChild(smoothButtonYaw);

    rootRotYawItem.appendChild(smoothControlsYaw);
    this.jointList.appendChild(rootRotYawItem);
  }

  private smoothRoot(): void {
    const currentFrame = this.motionPlayer.getCurrentFrame();
    
    // 找到相邻的关键帧
    const keyframeArray = Array.from(this.keyframes).sort((a, b) => a - b);
    let prevKeyframe = -1;
    let nextKeyframe = -1;
    
    for (let i = 0; i < keyframeArray.length; i++) {
      if (keyframeArray[i] < currentFrame) {
        prevKeyframe = keyframeArray[i];
      } else if (keyframeArray[i] > currentFrame) {
        nextKeyframe = keyframeArray[i];
        break;
      } else {
        // 当前帧就是关键帧，不需要平滑
        this.setState('playing', {
          detail: 'Current frame is a keyframe, no smoothing applied!',
        });
        return;
      }
    }
    
    // 获取用户指定的范围
    const beforeSlider = this.jointList.querySelector<HTMLInputElement>('.smooth-slider[data-root-control="smooth"][data-direction="before"]');
    const afterSlider = this.jointList.querySelector<HTMLInputElement>('.smooth-slider[data-root-control="smooth"][data-direction="after"]');
    
    const userRangeBefore = beforeSlider ? parseInt(beforeSlider.value, 10) : 5;
    const userRangeAfter = afterSlider ? parseInt(afterSlider.value, 10) : 5;
    
    // 计算用户指定的区间
    const userStart = Math.max(0, currentFrame - userRangeBefore);
    const userEnd = Math.min(this.motionPlayer.getFrameCount() - 1, currentFrame + userRangeAfter);
    
    // 计算关键帧之间的区间
    const keyframeStart = prevKeyframe !== -1 ? prevKeyframe : userStart;
    const keyframeEnd = nextKeyframe !== -1 ? nextKeyframe : userEnd;
    
    // 确定平滑范围：选择最小的区间
    let startFrame = Math.max(userStart, keyframeStart);
    let endFrame = Math.min(userEnd, keyframeEnd);
    
    console.log('Smoothing root between frames:', startFrame, 'and', endFrame);
    
    // 对root位置和旋转进行平滑
    this.smoothRootPosition(startFrame, currentFrame, endFrame);
    this.smoothRootRotation(startFrame, currentFrame, endFrame);
    
    this.setState('playing', {
      detail: 'Root motion smoothed successfully!',
    });
  }

  private smoothRootPosition(startFrame: number, currentFrame: number, endFrame: number): void {
    if (!this.motionPlayer.getClip()) {
      return;
    }
    
    // 保存当前帧的位置值
    const currentPos = this.motionPlayer.getRootPosition();
    
    // 获取开始帧和结束帧的位置
    const originalFrame = this.motionPlayer.getCurrentFrame();
    
    this.motionPlayer.seek(startFrame);
    const startPos = this.motionPlayer.getRootPosition();
    
    this.motionPlayer.seek(endFrame);
    const endPos = this.motionPlayer.getRootPosition();
    
    // 恢复到当前帧
    this.motionPlayer.seek(currentFrame);
    
    // 平滑开始帧到当前帧
    for (let frame = startFrame + 1; frame < currentFrame; frame++) {
      const t = (frame - startFrame) / (currentFrame - startFrame);
      const x = startPos.x + (currentPos.x - startPos.x) * t;
      const y = startPos.y + (currentPos.y - startPos.y) * t;
      const z = startPos.z + (currentPos.z - startPos.z) * t;
      
      this.motionPlayer.seek(frame);
      this.motionPlayer.setRootPosition(x, y, z);
    }
    
    // 平滑当前帧到结束帧
    for (let frame = currentFrame + 1; frame < endFrame; frame++) {
      const t = (frame - currentFrame) / (endFrame - currentFrame);
      const x = currentPos.x + (endPos.x - currentPos.x) * t;
      const y = currentPos.y + (endPos.y - currentPos.y) * t;
      const z = currentPos.z + (endPos.z - currentPos.z) * t;
      
      this.motionPlayer.seek(frame);
      this.motionPlayer.setRootPosition(x, y, z);
    }
    
    // 恢复到原始帧
    this.motionPlayer.seek(originalFrame);
  }

  private smoothRootAxis(axis: string, currentFrame: number, framesBefore: number, framesAfter: number): void {
    // 找到相邻的关键帧
    const keyframeArray = Array.from(this.keyframes).sort((a, b) => a - b);
    let prevKeyframe = -1;
    let nextKeyframe = -1;
    
    for (let i = 0; i < keyframeArray.length; i++) {
      if (keyframeArray[i] < currentFrame) {
        prevKeyframe = keyframeArray[i];
      } else if (keyframeArray[i] > currentFrame) {
        nextKeyframe = keyframeArray[i];
        break;
      } else {
        // 当前帧是关键帧，使用相邻的关键帧作为区间
        if (i > 0) {
          prevKeyframe = keyframeArray[i - 1];
        }
        if (i < keyframeArray.length - 1) {
          nextKeyframe = keyframeArray[i + 1];
        }
        break;
      }
    }
    
    // 计算用户指定的区间
    const userStart = Math.max(0, currentFrame - framesBefore);
    const userEnd = Math.min(this.motionPlayer.getFrameCount() - 1, currentFrame + framesAfter);
    
    // 计算关键帧之间的区间
    const keyframeStart = prevKeyframe !== -1 ? prevKeyframe : userStart;
    const keyframeEnd = nextKeyframe !== -1 ? nextKeyframe : userEnd;
    
    // 确定平滑范围：选择最小的区间
    let startFrame = Math.max(userStart, keyframeStart);
    let endFrame = Math.min(userEnd, keyframeEnd);
    
    console.log(`Smoothing root ${axis} between frames:`, startFrame, 'and', endFrame);
    
    // 四元数转欧拉角
    function quaternionToEuler(x: number, y: number, z: number, w: number): { roll: number; pitch: number; yaw: number } {
      const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
      const pitch = Math.asin(2 * (w * y - z * x));
      const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
      return { roll, pitch, yaw };
    }

    // 欧拉角转四元数
    function eulerToQuaternion(roll: number, pitch: number, yaw: number): { x: number; y: number; z: number; w: number } {
      const cy = Math.cos(yaw * 0.5);
      const sy = Math.sin(yaw * 0.5);
      const cp = Math.cos(pitch * 0.5);
      const sp = Math.sin(pitch * 0.5);
      const cr = Math.cos(roll * 0.5);
      const sr = Math.sin(roll * 0.5);

      return {
        w: cy * cp * cr + sy * sp * sr,
        x: cy * cp * sr - sy * sp * cr,
        y: sy * cp * sr + cy * sp * cr,
        z: sy * cp * cr - cy * sp * sr
      };
    }
    
    // 保存当前帧的值
    let currentValue: number;
    let startValue: number;
    let endValue: number;
    
    const originalFrame = this.motionPlayer.getCurrentFrame();
    
    if (axis === 'x' || axis === 'y' || axis === 'z') {
      // 位置轴
      const currentPos = this.motionPlayer.getRootPosition();
      currentValue = currentPos[axis as keyof typeof currentPos];
      
      // 获取开始帧和结束帧的值
      this.motionPlayer.seek(startFrame);
      const startPos = this.motionPlayer.getRootPosition();
      startValue = startPos[axis as keyof typeof startPos];
      
      this.motionPlayer.seek(endFrame);
      const endPos = this.motionPlayer.getRootPosition();
      endValue = endPos[axis as keyof typeof endPos];
      
      // 恢复到当前帧
      this.motionPlayer.seek(currentFrame);
      
      // 平滑开始帧到当前帧
      for (let frame = startFrame + 1; frame < currentFrame; frame++) {
        const t = (frame - startFrame) / (currentFrame - startFrame);
        const value = startValue + (currentValue - startValue) * t;
        
        this.motionPlayer.seek(frame);
        const currentPos = this.motionPlayer.getRootPosition();
        if (axis === 'x') {
          this.motionPlayer.setRootPosition(value, currentPos.y, currentPos.z);
        } else if (axis === 'y') {
          this.motionPlayer.setRootPosition(currentPos.x, value, currentPos.z);
        } else if (axis === 'z') {
          this.motionPlayer.setRootPosition(currentPos.x, currentPos.y, value);
        }
      }
      
      // 平滑当前帧到结束帧
      for (let frame = currentFrame + 1; frame < endFrame; frame++) {
        const t = (frame - currentFrame) / (endFrame - currentFrame);
        const value = currentValue + (endValue - currentValue) * t;
        
        this.motionPlayer.seek(frame);
        const currentPos = this.motionPlayer.getRootPosition();
        if (axis === 'x') {
          this.motionPlayer.setRootPosition(value, currentPos.y, currentPos.z);
        } else if (axis === 'y') {
          this.motionPlayer.setRootPosition(currentPos.x, value, currentPos.z);
        } else if (axis === 'z') {
          this.motionPlayer.setRootPosition(currentPos.x, currentPos.y, value);
        }
      }
    } else if (axis === 'roll' || axis === 'pitch' || axis === 'yaw') {
      // 旋转轴
      const currentRot = this.motionPlayer.getRootRotation();
      const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
      currentValue = currentEuler[axis as keyof typeof currentEuler];
      
      // 获取开始帧和结束帧的值
      this.motionPlayer.seek(startFrame);
      const startRot = this.motionPlayer.getRootRotation();
      const startEuler = quaternionToEuler(startRot.x, startRot.y, startRot.z, startRot.w);
      startValue = startEuler[axis as keyof typeof startEuler];
      
      this.motionPlayer.seek(endFrame);
      const endRot = this.motionPlayer.getRootRotation();
      const endEuler = quaternionToEuler(endRot.x, endRot.y, endRot.z, endRot.w);
      endValue = endEuler[axis as keyof typeof endEuler];
      
      // 恢复到当前帧
      this.motionPlayer.seek(currentFrame);
      
      // 平滑开始帧到当前帧
      for (let frame = startFrame + 1; frame < currentFrame; frame++) {
        const t = (frame - startFrame) / (currentFrame - startFrame);
        const value = startValue + (currentValue - startValue) * t;
        
        this.motionPlayer.seek(frame);
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        let quat = eulerToQuaternion(currentEuler.roll, currentEuler.pitch, currentEuler.yaw);
        if (axis === 'roll') {
          quat = eulerToQuaternion(value, currentEuler.pitch, currentEuler.yaw);
        } else if (axis === 'pitch') {
          quat = eulerToQuaternion(currentEuler.roll, value, currentEuler.yaw);
        } else if (axis === 'yaw') {
          quat = eulerToQuaternion(currentEuler.roll, currentEuler.pitch, value);
        }
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
      }
      
      // 平滑当前帧到结束帧
      for (let frame = currentFrame + 1; frame < endFrame; frame++) {
        const t = (frame - currentFrame) / (endFrame - currentFrame);
        const value = currentValue + (endValue - currentValue) * t;
        
        this.motionPlayer.seek(frame);
        const currentRot = this.motionPlayer.getRootRotation();
        const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        let quat = eulerToQuaternion(currentEuler.roll, currentEuler.pitch, currentEuler.yaw);
        if (axis === 'roll') {
          quat = eulerToQuaternion(value, currentEuler.pitch, currentEuler.yaw);
        } else if (axis === 'pitch') {
          quat = eulerToQuaternion(currentEuler.roll, value, currentEuler.yaw);
        } else if (axis === 'yaw') {
          quat = eulerToQuaternion(currentEuler.roll, currentEuler.pitch, value);
        }
        this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
      }
    }
    
    // 恢复到原始帧
    this.motionPlayer.seek(originalFrame);
  }

  private smoothRootRotation(startFrame: number, currentFrame: number, endFrame: number): void {
    if (!this.motionPlayer.getClip()) {
      return;
    }
    
    // 四元数转欧拉角
    function quaternionToEuler(x: number, y: number, z: number, w: number): { roll: number; pitch: number; yaw: number } {
      const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
      const pitch = Math.asin(2 * (w * y - z * x));
      const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
      return { roll, pitch, yaw };
    }

    // 欧拉角转四元数
    function eulerToQuaternion(roll: number, pitch: number, yaw: number): { x: number; y: number; z: number; w: number } {
      const cy = Math.cos(yaw * 0.5);
      const sy = Math.sin(yaw * 0.5);
      const cp = Math.cos(pitch * 0.5);
      const sp = Math.sin(pitch * 0.5);
      const cr = Math.cos(roll * 0.5);
      const sr = Math.sin(roll * 0.5);

      return {
        w: cy * cp * cr + sy * sp * sr,
        x: cy * cp * sr - sy * sp * cr,
        y: sy * cp * sr + cy * sp * cr,
        z: sy * cp * cr - cy * sp * sr
      };
    }
    
    // 保存当前帧的旋转值
    const currentRot = this.motionPlayer.getRootRotation();
    const currentEuler = quaternionToEuler(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
    
    // 获取开始帧和结束帧的旋转
    const originalFrame = this.motionPlayer.getCurrentFrame();
    
    this.motionPlayer.seek(startFrame);
    const startRot = this.motionPlayer.getRootRotation();
    const startEuler = quaternionToEuler(startRot.x, startRot.y, startRot.z, startRot.w);
    
    this.motionPlayer.seek(endFrame);
    const endRot = this.motionPlayer.getRootRotation();
    const endEuler = quaternionToEuler(endRot.x, endRot.y, endRot.z, endRot.w);
    
    // 恢复到当前帧
    this.motionPlayer.seek(currentFrame);
    
    // 平滑开始帧到当前帧
    for (let frame = startFrame + 1; frame < currentFrame; frame++) {
      const t = (frame - startFrame) / (currentFrame - startFrame);
      const roll = startEuler.roll + (currentEuler.roll - startEuler.roll) * t;
      const pitch = startEuler.pitch + (currentEuler.pitch - startEuler.pitch) * t;
      const yaw = startEuler.yaw + (currentEuler.yaw - startEuler.yaw) * t;
      
      const quat = eulerToQuaternion(roll, pitch, yaw);
      
      this.motionPlayer.seek(frame);
      this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
    }
    
    // 平滑当前帧到结束帧
    for (let frame = currentFrame + 1; frame < endFrame; frame++) {
      const t = (frame - currentFrame) / (endFrame - currentFrame);
      const roll = currentEuler.roll + (endEuler.roll - currentEuler.roll) * t;
      const pitch = currentEuler.pitch + (endEuler.pitch - currentEuler.pitch) * t;
      const yaw = currentEuler.yaw + (endEuler.yaw - currentEuler.yaw) * t;
      
      const quat = eulerToQuaternion(roll, pitch, yaw);
      
      this.motionPlayer.seek(frame);
      this.motionPlayer.setRootRotation(quat.x, quat.y, quat.z, quat.w);
    }
    
    // 恢复到原始帧
    this.motionPlayer.seek(originalFrame);
  }

  private updateJointPanelValues(jointNames: string[], jointValues: number[]): void {
    // 更新root关节的值
    const rootPos = this.motionPlayer.getRootPosition();
    const rootRot = this.motionPlayer.getRootRotation();

    // 更新root位置输入框
    const posXInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="position"][data-axis="x"]');
    if (posXInput) posXInput.value = rootPos.x.toFixed(4);
    const posYInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="position"][data-axis="y"]');
    if (posYInput) posYInput.value = rootPos.y.toFixed(4);
    const posZInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="position"][data-axis="z"]');
    if (posZInput) posZInput.value = rootPos.z.toFixed(4);

    // 更新root位置滑块
    const posXSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="position"][data-axis="x"]');
    if (posXSlider) posXSlider.value = rootPos.x.toString();
    const posYSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="position"][data-axis="y"]');
    if (posYSlider) posYSlider.value = rootPos.y.toString();
    const posZSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="position"][data-axis="z"]');
    if (posZSlider) posZSlider.value = rootPos.z.toString();

    // 更新root旋转输入框
    const rotXInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="x"]');
    if (rotXInput) rotXInput.value = rootRot.x.toFixed(4);
    const rotYInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="y"]');
    if (rotYInput) rotYInput.value = rootRot.y.toFixed(4);
    const rotZInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="z"]');
    if (rotZInput) rotZInput.value = rootRot.z.toFixed(4);
    const rotWInput = this.jointList.querySelector<HTMLInputElement>('.joint-input[data-root-control="rotation"][data-axis="w"]');
    if (rotWInput) rotWInput.value = rootRot.w.toFixed(4);

    // 更新root旋转滑块
    const rotXSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="x"]');
    if (rotXSlider) rotXSlider.value = rootRot.x.toString();
    const rotYSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="y"]');
    if (rotYSlider) rotYSlider.value = rootRot.y.toString();
    const rotZSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="z"]');
    if (rotZSlider) rotZSlider.value = rootRot.z.toString();
    const rotWSlider = this.jointList.querySelector<HTMLInputElement>('.root-slider[data-root-control="rotation"][data-axis="w"]');
    if (rotWSlider) rotWSlider.value = rootRot.w.toString();

    // 更新普通关节的值
    const jointInputs = this.jointList.querySelectorAll<HTMLInputElement>('.joint-input:not([data-root-control])');
    const jointSliders = this.jointList.querySelectorAll<HTMLInputElement>('.joint-slider:not([data-root-control])');
    
    jointInputs.forEach((input, index) => {
      if (index < jointValues.length) {
        input.value = jointValues[index].toFixed(4);
      }
    });
    
    jointSliders.forEach((slider, index) => {
      if (index < jointValues.length) {
        slider.value = jointValues[index].toString();
      }
    });
  }

  private showJointPanel(): void {
    if (isUrdfMotionKind(this.currentMotionKind)) {
      const jointNames = this.motionPlayer.getJointNames();
      const jointValues = this.motionPlayer.getCurrentJointValues();
      if (jointNames.length > 0) {
        this.renderJointPanel(jointNames, jointValues);
        this.jointPanel.hidden = false;
      }
    }
  }

  private hideJointPanel(): void {
    this.jointPanel.hidden = true;
    this.jointList.innerHTML = '';
  }

  private readonly onDatasetPanelMinimizeClick = (): void => {
    this.isDatasetPanelMinimized = !this.isDatasetPanelMinimized;
    this.datasetPanel.dataset.minimized = this.isDatasetPanelMinimized ? 'true' : 'false';
    this.datasetPanelMinimizeBtn.textContent = this.isDatasetPanelMinimized ? '+' : '_';
  };

  private readonly onStatusPanelMinimizeClick = (): void => {
    this.isStatusPanelMinimized = !this.isStatusPanelMinimized;
    this.statusPanel.dataset.minimized = this.isStatusPanelMinimized ? 'true' : 'false';
    this.statusPanelMinimizeBtn.textContent = this.isStatusPanelMinimized ? '+' : '_';
  };
}
