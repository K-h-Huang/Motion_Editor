import { describe, expect, it } from 'vitest';

import type { DroppedFileMap, MotionSchema } from '../../types/viewer';
import { DEFAULT_MOTION_FPS, DEFAULT_ROOT_COMPONENT_COUNT, DEFAULT_ROOT_JOINT_NAME } from './MotionSchema';
import { CsvMotionService, parseMotionCsv } from './CsvMotionService';

const TEST_MOTION_SCHEMA: MotionSchema = {
  rootJointName: DEFAULT_ROOT_JOINT_NAME,
  rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
  jointNames: ['joint_a', 'joint_b', 'joint_c'],
};

function buildOrderedFrameValues(seed: number, columnCount = 10): string {
  return Array.from({ length: columnCount }, (_, index) => (seed + index * 0.01).toFixed(6)).join(',');
}

function buildFileMap(entries: Record<string, string>): DroppedFileMap {
  const fileMap: DroppedFileMap = new Map();
  for (const [path, content] of Object.entries(entries)) {
    fileMap.set(path, new File([content], path.split('/').pop() ?? 'motion.csv'));
  }
  return fileMap;
}

describe('parseMotionCsv', () => {
  it('parses ordered csv rows when column count matches root + schema joints', () => {
    const csvContent = `${buildOrderedFrameValues(0)}\n${buildOrderedFrameValues(1)}\n`;
    const result = parseMotionCsv(csvContent, 'motions/dance.csv', TEST_MOTION_SCHEMA);

    expect(result.clip.frameCount).toBe(2);
    expect(result.clip.stride).toBe(10);
    expect(result.clip.fps).toBe(DEFAULT_MOTION_FPS);
    expect(result.clip.csvMode).toBe('ordered');
    expect(result.clip.sourceColumnCount).toBe(10);
    expect(result.clip.data.length).toBe(20);
    expect(result.warnings).toHaveLength(0);
  });

  it('throws when ordered csv has fewer columns than required schema', () => {
    const csvContent = `${buildOrderedFrameValues(0, 9)}\n`;
    expect(() => parseMotionCsv(csvContent, 'broken.csv', TEST_MOTION_SCHEMA)).toThrow(
      /expected at least 10/,
    );
  });

  it('warns and ignores tail columns when ordered csv has extra columns', () => {
    const csvContent = `${buildOrderedFrameValues(0, 12)}\n`;
    const result = parseMotionCsv(csvContent, 'extra.csv', TEST_MOTION_SCHEMA);

    expect(result.clip.frameCount).toBe(1);
    expect(result.clip.stride).toBe(10);
    expect(result.warnings.some((warning) => warning.includes('extra joint columns'))).toBe(true);
  });

  it('parses header csv by names and remaps columns to canonical root+joint order', () => {
    const header = [
      'joint_b',
      'root_qw',
      'root_y',
      'root_z',
      'joint_c',
      'root_x',
      'root_qx',
      'joint_a',
      'root_qz',
      'root_qy',
      'frame',
    ];
    const row = ['8', '7', '2', '3', '9', '1', '4', '6', '5', '0', '999'];
    const csvContent = `${header.join(',')}\n${row.join(',')}\n`;
    const result = parseMotionCsv(csvContent, 'header.csv', TEST_MOTION_SCHEMA);

    expect(result.clip.frameCount).toBe(1);
    expect(result.clip.csvMode).toBe('header');
    expect(result.clip.sourceColumnCount).toBe(11);
    expect(Array.from(result.clip.data)).toEqual([1, 2, 3, 4, 0, 5, 7, 6, 8, 9]);
    expect(result.warnings.some((warning) => warning.includes('Detected CSV header row'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('unmapped columns'))).toBe(true);
  });

  it('throws when header csv is missing non-fixed joints from the URDF schema', () => {
    const csvContent = `root_x,root_y,root_z,root_qx,root_qy,root_qz,root_qw,joint_a,joint_b\n1,2,3,4,5,6,7,8,9\n`;
    expect(() => parseMotionCsv(csvContent, 'missing_joint.csv', TEST_MOTION_SCHEMA)).toThrow(
      /Missing non-fixed joints/,
    );
  });

  it('throws on non-numeric values in mapped columns', () => {
    const csvContent = `root_x,root_y,root_z,root_qx,root_qy,root_qz,root_qw,joint_a,joint_b,joint_c\n1,2,3,4,5,6,7,8,bad,10\n`;
    expect(() => parseMotionCsv(csvContent, 'broken.csv', TEST_MOTION_SCHEMA)).toThrow(
      /not a valid number/,
    );
  });

  it('throws on empty csv', () => {
    expect(() => parseMotionCsv('', 'empty.csv', TEST_MOTION_SCHEMA)).toThrow(/CSV is empty/);
  });
});

describe('CsvMotionService', () => {
  it('deterministically selects primary csv and reports warning for multiple candidates', async () => {
    const fileMap = buildFileMap({
      'deep/path/b.csv': `${buildOrderedFrameValues(0)}\n`,
      'a.csv': `${buildOrderedFrameValues(1)}\n`,
    });

    const service = new CsvMotionService();
    const result = await service.loadFromDroppedFiles(fileMap, TEST_MOTION_SCHEMA);

    expect(result.selectedCsvPath).toBe('a.csv');
    expect(result.warnings.some((warning) => warning.includes('Multiple CSV files'))).toBe(true);
  });
});

