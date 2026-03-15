import { describe, expect, it } from 'vitest';

import type { DroppedFileMap } from '../../types/viewer';
import { BvhMotionService } from './BvhMotionService';

const SIMPLE_BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 0.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Chest
  {
    OFFSET 0.0 10.0 0.0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0.0 5.0 0.0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0 0 0 0 0 0 0 0 0
1 2 3 10 20 30 5 0 -5
`;

const OFFSET_ROOT_BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 0.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  End Site
  {
    OFFSET 0.0 5.0 0.0
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
10 0 -4 0 0 0
12 0 -1 0 0 0
`;

function buildFileMap(entries: Record<string, string>): DroppedFileMap {
  const fileMap: DroppedFileMap = new Map();
  for (const [path, content] of Object.entries(entries)) {
    fileMap.set(path, new File([content], path.split('/').pop() ?? 'motion.bvh'));
  }
  return fileMap;
}

describe('BvhMotionService', () => {
  it('deterministically lists bvh paths by depth then lexicographic order', () => {
    const service = new BvhMotionService();
    const fileMap = buildFileMap({
      'deep/path/z.bvh': SIMPLE_BVH,
      'a.bvh': SIMPLE_BVH,
      'deep/b.bvh': SIMPLE_BVH,
      'ignore.csv': 'x',
    });

    expect(service.getAvailableBvhPaths(fileMap)).toEqual(['a.bvh', 'deep/b.bvh', 'deep/path/z.bvh']);
  });

  it('loads bvh clip and builds a playable scene object', async () => {
    const service = new BvhMotionService();
    const fileMap = buildFileMap({
      'motions/walk.bvh': SIMPLE_BVH,
    });

    const result = await service.loadFromDroppedFiles(fileMap);

    expect(result.selectedBvhPath).toBe('motions/walk.bvh');
    expect(result.clip.name).toBe('walk.bvh');
    expect(result.frameCount).toBe(2);
    expect(result.fps).toBeCloseTo(30, 3);
    expect(result.jointCount).toBe(2);
    expect(result.linearUnit).toBe('m');
    expect(result.unitScale).toBeCloseTo(1, 8);
    expect(result.sceneObject.scale.x).toBeCloseTo(1, 8);
    expect(result.sceneObject.children.length).toBe(2);
    expect(result.sceneObject.userData.rootTrackNode).toBe(result.playbackTarget.skeleton.bones[0]);
    expect(result.playbackTarget.skeleton.bones.length).toBeGreaterThan(0);
  });

  it('applies requested unit scaling when requested', async () => {
    const service = new BvhMotionService();
    const fileMap = buildFileMap({
      'motions/walk_units.bvh': SIMPLE_BVH,
    });

    const expectedScales: Array<{ unit: 'dm' | 'cm' | 'inch' | 'feet'; scale: number }> = [
      { unit: 'dm', scale: 0.1 },
      { unit: 'cm', scale: 0.01 },
      { unit: 'inch', scale: 0.0254 },
      { unit: 'feet', scale: 0.3048 },
    ];

    for (const item of expectedScales) {
      const result = await service.loadFromDroppedFiles(fileMap, undefined, item.unit);
      expect(result.linearUnit).toBe(item.unit);
      expect(result.unitScale).toBeCloseTo(item.scale, 8);
      expect(result.sceneObject.scale.x).toBeCloseTo(item.scale, 8);
      expect(result.sceneObject.scale.y).toBeCloseTo(item.scale, 8);
      expect(result.sceneObject.scale.z).toBeCloseTo(item.scale, 8);
    }
  });

  it('recenters root XZ by the first frame position', async () => {
    const service = new BvhMotionService();
    const fileMap = buildFileMap({
      'motions/offset.bvh': OFFSET_ROOT_BVH,
    });

    const result = await service.loadFromDroppedFiles(fileMap);
    const rootTrack = result.clip.tracks.find((track: any) => track.name === 'Hips.position');

    expect(rootTrack).toBeTruthy();
    expect(rootTrack.values[0]).toBeCloseTo(0, 6);
    expect(rootTrack.values[2]).toBeCloseTo(0, 6);
    expect(rootTrack.values[3]).toBeCloseTo(2, 6);
    expect(rootTrack.values[5]).toBeCloseTo(3, 6);
  });
});
