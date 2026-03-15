import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { DroppedFileMap, MotionSchema } from '../../types/viewer';
import { DEFAULT_ROOT_COMPONENT_COUNT, DEFAULT_ROOT_JOINT_NAME } from './MotionSchema';
import { MimicKitMotionService } from './MimicKitMotionService';

function buildSchema(jointCount: number): MotionSchema {
  return {
    rootJointName: DEFAULT_ROOT_JOINT_NAME,
    rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames: Array.from({ length: jointCount }, (_, index) => `joint_${index}`),
  };
}

async function buildFixtureFileMap(paths: string[]): Promise<DroppedFileMap> {
  const fileMap: DroppedFileMap = new Map();
  for (const path of paths) {
    const fixturePath = path.startsWith('presets/')
      ? `../../../public/${path}`
      : `../../../${path}`;
    const buffer = await readFile(new URL(fixturePath, import.meta.url));
    fileMap.set(path, new File([buffer], path.split('/').pop() ?? 'motion.pkl'));
  }
  return fileMap;
}

describe('MimicKitMotionService', () => {
  it('parses a G1 MimicKit pickle into a playable MotionClip', async () => {
    const service = new MimicKitMotionService();
    const fileMap = await buildFixtureFileMap(['presets/MimicKit/g1/g1_walk.pkl']);

    const result = await service.loadFromDroppedFiles(fileMap, buildSchema(29));

    expect(result.selectedMotionPath).toBe('presets/MimicKit/g1/g1_walk.pkl');
    expect(result.clip.name).toBe('g1_walk.pkl');
    expect(result.clip.frameCount).toBe(125);
    expect(result.clip.fps).toBe(120);
    expect(result.clip.sourceColumnCount).toBe(35);
    expect(result.clip.stride).toBe(36);
    expect(result.clip.data[0]).toBeCloseTo(0.000535024, 6);
    expect(result.clip.data[1]).toBeCloseTo(-0.00671921, 6);
    expect(result.clip.data[2]).toBeCloseTo(0.756082, 6);
    expect(result.clip.data[7]).toBeCloseTo(0.227607, 5);

    const rootQuat = Array.from(result.clip.data.slice(3, 7));
    const quatNorm = Math.hypot(...rootQuat);
    expect(quatNorm).toBeCloseTo(1, 5);
    expect(result.warnings).toHaveLength(0);
  });

  it('auto-selects a compatible Go2 MimicKit clip from a mixed PKL drop', async () => {
    const service = new MimicKitMotionService();
    const fileMap = await buildFixtureFileMap([
      'presets/MimicKit/g1/g1_walk.pkl',
      'presets/MimicKit/go2/go2_trot.pkl',
    ]);

    const result = await service.loadFromDroppedFiles(fileMap, buildSchema(12));

    expect(result.selectedMotionPath).toBe('presets/MimicKit/go2/go2_trot.pkl');
    expect(
      result.warnings.some((warning) => warning.includes('active URDF joint count (12)')),
    ).toBe(true);
  });

  it('deterministically lists candidate PKLs and excludes SMPL model pickles', () => {
    const service = new MimicKitMotionService();
    const fileMap: DroppedFileMap = new Map([
      ['deep/path/z.pkl', new File(['z'], 'z.pkl')],
      ['a.pkl', new File(['a'], 'a.pkl')],
      [
        'models/basicmodel_neutral_lbs_10_207_0_v1.1.0.pkl',
        new File(['smpl'], 'basicmodel_neutral_lbs_10_207_0_v1.1.0.pkl'),
      ],
      ['ignore.csv', new File(['x'], 'ignore.csv')],
    ]);

    expect(service.getAvailablePklPaths(fileMap)).toEqual(['a.pkl', 'deep/path/z.pkl']);
  });

  it('throws when no compatible MimicKit clip matches the active URDF joint count', async () => {
    const service = new MimicKitMotionService();
    const fileMap = await buildFixtureFileMap(['presets/MimicKit/g1/g1_walk.pkl']);

    await expect(service.loadFromDroppedFiles(fileMap, buildSchema(12))).rejects.toThrow(
      /Expected 12 joints, found 29/,
    );
  });
});
