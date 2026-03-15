import type { DroppedFileMap } from '../../types/viewer';

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }

  const withoutQuery = trimmed.split('#')[0].split('?')[0];
  const withForwardSlashes = withoutQuery.replace(/\\/g, '/');
  const tokens = withForwardSlashes.split('/');
  const normalized: string[] = [];

  for (const token of tokens) {
    if (!token || token === '.') {
      continue;
    }

    if (token === '..') {
      if (normalized.length > 0) {
        normalized.pop();
      }
      continue;
    }

    normalized.push(token);
  }

  return normalized.join('/');
}

export function getPathDepth(path: string): number {
  const normalized = normalizePath(path);
  if (!normalized) {
    return 0;
  }

  return normalized.split('/').length;
}

export function sortUrdfPaths(paths: string[]): string[] {
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

export function selectPrimaryUrdfPath(paths: string[]): string | null {
  const sorted = sortUrdfPaths(paths);
  return sorted.length > 0 ? sorted[0] : null;
}

export function getDirectoryPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) {
    return '';
  }

  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex < 0) {
    return '';
  }

  return normalized.slice(0, slashIndex);
}

export function getBaseName(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) {
    return '';
  }

  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex < 0) {
    return normalized;
  }

  return normalized.slice(slashIndex + 1);
}

export function getFileExtension(path: string): string {
  const baseName = getBaseName(path);
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex < 0) {
    return '';
  }

  return baseName.slice(dotIndex + 1).toLowerCase();
}

export function extractRecoverablePathFromBlobUrl(pathOrUrl: string): string | null {
  const trimmed = pathOrUrl.trim();
  if (!trimmed.startsWith('blob:')) {
    return null;
  }

  const malformedBlobMatch = trimmed.match(/^blob:https?:\/\/[^/]+\/(.+)$/i);
  if (!malformedBlobMatch || !malformedBlobMatch[1]) {
    return null;
  }

  const blobTail = malformedBlobMatch[1];
  const fileName = blobTail.split('/').pop()?.split('#')[0]?.split('?')[0] ?? '';
  if (!/\.[a-zA-Z\d]{2,8}$/.test(fileName)) {
    return null;
  }

  return blobTail;
}

function extractPathFromUrl(pathOrUrl: string): string {
  const trimmed = pathOrUrl.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('package://')) {
    return trimmed;
  }

  if (trimmed.startsWith('blob:')) {
    const recoverableBlobPath = extractRecoverablePathFromBlobUrl(trimmed);
    if (recoverableBlobPath) {
      return recoverableBlobPath;
    }

    return trimmed;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.pathname;
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function directLookup(candidatePath: string, fileMap: DroppedFileMap): string | null {
  if (fileMap.has(candidatePath)) {
    return candidatePath;
  }

  const lowerCandidate = candidatePath.toLowerCase();
  for (const existingKey of fileMap.keys()) {
    if (existingKey.toLowerCase() === lowerCandidate) {
      return existingKey;
    }
  }

  return null;
}

function buildRequestedPathCandidates(requestedUrl: string): string[] {
  const candidates = new Set<string>();
  const extractedPath = extractPathFromUrl(requestedUrl);
  if (!extractedPath) {
    return [];
  }

  const normalizedExtracted = normalizePath(extractedPath);
  if (normalizedExtracted) {
    candidates.add(normalizedExtracted);
  }

  if (extractedPath.startsWith('package://')) {
    const packageRelative = extractedPath.replace(/^package:\/\//, '');
    const normalizedPackageRelative = normalizePath(packageRelative);
    if (normalizedPackageRelative) {
      candidates.add(normalizedPackageRelative);
    }

    const packageSegments = normalizedPackageRelative.split('/');
    if (packageSegments.length > 1) {
      candidates.add(packageSegments.slice(1).join('/'));
    }
  }

  return [...candidates];
}

export function resolveFileKeyForRequest(
  requestedUrl: string,
  urdfPath: string,
  fileMap: DroppedFileMap,
): string | null {
  const requestCandidates = buildRequestedPathCandidates(requestedUrl);
  if (requestCandidates.length === 0) {
    return null;
  }

  const urdfDirectory = getDirectoryPath(urdfPath);
  const exactCandidates = new Set<string>();

  for (const requestCandidate of requestCandidates) {
    if (urdfDirectory) {
      exactCandidates.add(normalizePath(`${urdfDirectory}/${requestCandidate}`));
    }
    exactCandidates.add(normalizePath(requestCandidate));
  }

  for (const candidate of exactCandidates) {
    const directMatch = directLookup(candidate, fileMap);
    if (directMatch) {
      return directMatch;
    }
  }

  const targetBaseName = getBaseName(requestCandidates[0]).toLowerCase();
  if (!targetBaseName) {
    return null;
  }

  for (const key of fileMap.keys()) {
    if (getBaseName(key).toLowerCase() === targetBaseName) {
      return key;
    }
  }

  return null;
}
