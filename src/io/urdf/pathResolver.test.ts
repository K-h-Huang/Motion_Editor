import { describe, expect, it } from 'vitest';

import {
  extractRecoverablePathFromBlobUrl,
  normalizePath,
  resolveFileKeyForRequest,
  selectPrimaryUrdfPath,
  sortUrdfPaths,
} from './pathResolver';
import type { DroppedFileMap } from '../../types/viewer';

function createMockFile(content: string, name: string): File {
  return new File([content], name);
}

describe('pathResolver', () => {
  it('normalizes relative path tokens and slashes', () => {
    expect(normalizePath('.\\robot\\meshes\\..\\pelvis.STL')).toBe('robot/pelvis.STL');
    expect(normalizePath('/robot/./meshes/body.STL')).toBe('robot/meshes/body.STL');
    expect(normalizePath('robot//meshes///arm.STL')).toBe('robot/meshes/arm.STL');
  });

  it('sorts and selects urdf path by depth then name', () => {
    const input = ['b/model.urdf', 'a/z/model.urdf', 'a/model.urdf'];
    expect(sortUrdfPaths(input)).toEqual(['a/model.urdf', 'b/model.urdf', 'a/z/model.urdf']);
    expect(selectPrimaryUrdfPath(input)).toBe('a/model.urdf');
  });

  it('resolves file key with urdf-directory priority and basename fallback', () => {
    const fileMap: DroppedFileMap = new Map([
      ['g1/g1.urdf', createMockFile('<robot/>', 'g1.urdf')],
      ['g1/meshes/pelvis.STL', createMockFile('stl', 'pelvis.STL')],
      ['backup/meshes/pelvis.STL', createMockFile('stl', 'pelvis.STL')],
    ]);

    expect(resolveFileKeyForRequest('meshes/pelvis.STL', 'g1/g1.urdf', fileMap)).toBe(
      'g1/meshes/pelvis.STL',
    );
    expect(resolveFileKeyForRequest('pelvis.STL', 'g1/g1.urdf', fileMap)).toBe(
      'g1/meshes/pelvis.STL',
    );
  });

  it('recovers file-like blob tails used by collada texture requests', () => {
    expect(
      extractRecoverablePathFromBlobUrl('blob:https://viewer.roboticsfan.com/trunk_A1.png'),
    ).toBe('trunk_A1.png');
    expect(
      extractRecoverablePathFromBlobUrl(
        'blob:https://viewer.roboticsfan.com/70f4b3a7-88e9-48d8-aaf2-cf6c3214d669',
      ),
    ).toBeNull();
  });

  it('resolves malformed blob texture urls through basename fallback', () => {
    const fileMap: DroppedFileMap = new Map([
      ['a1_description/urdf/a1.urdf', createMockFile('<robot/>', 'a1.urdf')],
      ['a1_description/meshes/trunk.dae', createMockFile('dae', 'trunk.dae')],
      ['a1_description/meshes/trunk_A1.png', createMockFile('png', 'trunk_A1.png')],
    ]);

    expect(
      resolveFileKeyForRequest(
        'blob:https://viewer.roboticsfan.com/trunk_A1.png',
        'a1_description/urdf/a1.urdf',
        fileMap,
      ),
    ).toBe('a1_description/meshes/trunk_A1.png');
  });
});
