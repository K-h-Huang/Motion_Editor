import { describe, expect, it } from 'vitest';

import type { DroppedFileMap, MotionSchema } from '../../types/viewer';
import {
  DEFAULT_ROOT_COMPONENT_COUNT,
  DEFAULT_ROOT_JOINT_NAME,
  G1_BEYOND_MIMIC_JOINT_ORDER,
  H1_2_BEYOND_MIMIC_JOINT_ORDER,
  H1_BEYOND_MIMIC_JOINT_ORDER,
} from './MotionSchema';
import { BeyondMimicMotionService } from './BeyondMimicMotionService';
import { parseNpzFile } from './NumpyIO';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeAscii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function createNpyFloat64(values: Float64Array, shape: number[]): Uint8Array {
  const elementCount = shape.reduce((product, size) => product * size, 1);
  if (elementCount !== values.length) {
    throw new Error(`Invalid test NPY shape ${shape.join(',')} for ${values.length} values.`);
  }

  const shapeToken =
    shape.length === 0
      ? ''
      : shape.length === 1
        ? `${shape[0]},`
        : shape.join(', ');
  const headerBase = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shapeToken}), }`;
  const preambleLength = 10;
  let header = headerBase;
  let headerBytes = encodeAscii(header);
  let totalHeaderLength = preambleLength + headerBytes.length + 1;

  const paddingRemainder = totalHeaderLength % 16;
  const paddingSpaces = paddingRemainder === 0 ? 0 : 16 - paddingRemainder;
  if (paddingSpaces > 0) {
    header = `${header}${' '.repeat(paddingSpaces)}`;
    headerBytes = encodeAscii(header);
    totalHeaderLength = preambleLength + headerBytes.length + 1;
  }

  const output = new Uint8Array(totalHeaderLength + values.length * 8);
  output.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
  output[6] = 1;
  output[7] = 0;
  writeUint16(output, 8, headerBytes.length + 1);
  output.set(headerBytes, 10);
  output[10 + headerBytes.length] = 0x0a;

  const view = new DataView(output.buffer, totalHeaderLength);
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat64(index * 8, values[index] ?? 0, true);
  }

  return output;
}

interface ZipEntryInput {
  fileName: string;
  uncompressedData: Uint8Array;
}

function createStoredNpz(entries: ZipEntryInput[]): Uint8Array {
  const localFileRecords: Uint8Array[] = [];
  const centralDirectoryRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileNameBytes = encodeAscii(entry.fileName);
    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    writeUint32(localHeader, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, 0);
    writeUint16(localHeader, 12, 0);
    writeUint32(localHeader, 14, 0);
    writeUint32(localHeader, 18, entry.uncompressedData.length);
    writeUint32(localHeader, 22, entry.uncompressedData.length);
    writeUint16(localHeader, 26, fileNameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileNameBytes, 30);

    const localRecord = concatBytes([localHeader, entry.uncompressedData]);
    localFileRecords.push(localRecord);

    const centralRecord = new Uint8Array(46 + fileNameBytes.length);
    writeUint32(centralRecord, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
    writeUint16(centralRecord, 4, 20);
    writeUint16(centralRecord, 6, 20);
    writeUint16(centralRecord, 8, 0);
    writeUint16(centralRecord, 10, 0);
    writeUint16(centralRecord, 12, 0);
    writeUint16(centralRecord, 14, 0);
    writeUint32(centralRecord, 16, 0);
    writeUint32(centralRecord, 20, entry.uncompressedData.length);
    writeUint32(centralRecord, 24, entry.uncompressedData.length);
    writeUint16(centralRecord, 28, fileNameBytes.length);
    writeUint16(centralRecord, 30, 0);
    writeUint16(centralRecord, 32, 0);
    writeUint16(centralRecord, 34, 0);
    writeUint16(centralRecord, 36, 0);
    writeUint32(centralRecord, 38, 0);
    writeUint32(centralRecord, 42, localOffset);
    centralRecord.set(fileNameBytes, 46);
    centralDirectoryRecords.push(centralRecord);

    localOffset += localRecord.length;
  }

  const localData = concatBytes(localFileRecords);
  const centralDirectory = concatBytes(centralDirectoryRecords);
  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(endRecord, 4, 0);
  writeUint16(endRecord, 6, 0);
  writeUint16(endRecord, 8, entries.length);
  writeUint16(endRecord, 10, entries.length);
  writeUint32(endRecord, 12, centralDirectory.length);
  writeUint32(endRecord, 16, localData.length);
  writeUint16(endRecord, 20, 0);

  return concatBytes([localData, centralDirectory, endRecord]);
}

function createBeyondMimicNpz(jointCount: number, bodyCount = 1): Uint8Array {
  const frameCount = 2;
  const jointPos = new Float64Array(frameCount * jointCount);
  for (let index = 0; index < jointPos.length; index += 1) {
    jointPos[index] = index + 0.25;
  }
  const bodyPos = new Float64Array(frameCount * bodyCount * 3);
  for (let index = 0; index < bodyPos.length; index += 1) {
    bodyPos[index] = index + 1;
  }
  const bodyQuat = new Float64Array(frameCount * bodyCount * 4);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex += 1) {
      bodyQuat[(frameIndex * bodyCount + bodyIndex) * 4] = 1;
    }
  }
  bodyQuat[frameCount > 1 ? bodyCount * 4 : 0] = 0;
  bodyQuat[(frameCount > 1 ? bodyCount * 4 : 0) + 1] = 1;

  return createStoredNpz([
    {
      fileName: 'fps.npy',
      uncompressedData: createNpyFloat64(new Float64Array([50]), [1]),
    },
    {
      fileName: 'joint_pos.npy',
      uncompressedData: createNpyFloat64(jointPos, [frameCount, jointCount]),
    },
    {
      fileName: 'joint_vel.npy',
      uncompressedData: createNpyFloat64(new Float64Array(frameCount * jointCount), [frameCount, jointCount]),
    },
    {
      fileName: 'body_pos_w.npy',
      uncompressedData: createNpyFloat64(bodyPos, [frameCount, bodyCount, 3]),
    },
    {
      fileName: 'body_quat_w.npy',
      uncompressedData: createNpyFloat64(bodyQuat, [frameCount, bodyCount, 4]),
    },
    {
      fileName: 'body_lin_vel_w.npy',
      uncompressedData: createNpyFloat64(new Float64Array(frameCount * bodyCount * 3), [frameCount, bodyCount, 3]),
    },
    {
      fileName: 'body_ang_vel_w.npy',
      uncompressedData: createNpyFloat64(new Float64Array(frameCount * bodyCount * 3), [frameCount, bodyCount, 3]),
    },
  ]);
}

function createSmplLikeNpz(): Uint8Array {
  return createStoredNpz([
    {
      fileName: 'poses.npy',
      uncompressedData: createNpyFloat64(new Float64Array([0, 0, 0]), [1, 3]),
    },
    {
      fileName: 'trans.npy',
      uncompressedData: createNpyFloat64(new Float64Array([0, 0, 0]), [1, 3]),
    },
  ]);
}

function buildFileMap(entries: Record<string, Uint8Array>): DroppedFileMap {
  const fileMap: DroppedFileMap = new Map();
  for (const [path, bytes] of Object.entries(entries)) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    fileMap.set(path, new File([copy], path.split('/').pop() ?? 'motion.npz'));
  }
  return fileMap;
}

function buildSchema(jointNames: readonly string[]): MotionSchema {
  return {
    rootJointName: DEFAULT_ROOT_JOINT_NAME,
    rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames: [...jointNames],
  };
}

describe('BeyondMimicMotionService', () => {
  it('detects BeyondMimic NPZ files without claiming SMPL-style NPZ files', async () => {
    const service = new BeyondMimicMotionService();
    const fileMap = buildFileMap({
      'motions/smpl_motion.npz': createSmplLikeNpz(),
      'motions/h1_motion.npz': createBeyondMimicNpz(H1_BEYOND_MIMIC_JOINT_ORDER.length),
    });

    await expect(service.getAvailableNpzPaths(fileMap)).resolves.toEqual([
      'motions/h1_motion.npz',
    ]);
  });

  it('loads H1 BeyondMimic NPZ root and joints into editable motion clips', async () => {
    const service = new BeyondMimicMotionService();
    const fileMap = buildFileMap({
      'motions/h1_motion.npz': createBeyondMimicNpz(H1_BEYOND_MIMIC_JOINT_ORDER.length),
    });

    const result = await service.loadFromDroppedFiles(
      fileMap,
      buildSchema(H1_BEYOND_MIMIC_JOINT_ORDER),
    );

    expect(result.selectedMotionPath).toBe('motions/h1_motion.npz');
    expect(result.clip.fps).toBe(50);
    expect(result.clip.frameCount).toBe(2);
    expect(result.clip.schema.jointNames).toEqual([...H1_BEYOND_MIMIC_JOINT_ORDER]);
    expect(result.clip.data[0]).toBe(1);
    expect(result.clip.data[1]).toBe(2);
    expect(result.clip.data[2]).toBe(3);
    expect(result.clip.data[3]).toBe(0);
    expect(result.clip.data[4]).toBe(0);
    expect(result.clip.data[5]).toBe(0);
    expect(result.clip.data[6]).toBe(1);
    expect(result.clip.data[DEFAULT_ROOT_COMPONENT_COUNT]).toBeCloseTo(0.25);

    const secondFrameBase = result.clip.stride;
    expect(result.clip.data[secondFrameBase]).toBe(4);
    expect(result.clip.data[secondFrameBase + 1]).toBe(5);
    expect(result.clip.data[secondFrameBase + 2]).toBe(6);
    expect(result.clip.data[secondFrameBase + 3]).toBe(1);
    expect(result.clip.data[secondFrameBase + 4]).toBe(0);
    expect(result.clip.data[secondFrameBase + 5]).toBe(0);
    expect(result.clip.data[secondFrameBase + 6]).toBe(0);
    expect(result.warnings.some((warning) => warning.includes('H1 joint order'))).toBe(true);
  });

  it('maps G1 columns by the BeyondMimic script order even when the active schema order differs', async () => {
    const service = new BeyondMimicMotionService();
    const fileMap = buildFileMap({
      'motions/g1_motion.npz': createBeyondMimicNpz(G1_BEYOND_MIMIC_JOINT_ORDER.length),
    });

    const result = await service.loadFromDroppedFiles(
      fileMap,
      buildSchema([...G1_BEYOND_MIMIC_JOINT_ORDER].reverse()),
    );

    expect(result.clip.schema.jointNames).toEqual([...G1_BEYOND_MIMIC_JOINT_ORDER]);
    expect(result.warnings.some((warning) => warning.includes('G1 joint order'))).toBe(true);
  });

  for (const robotCase of [
    { label: 'H1', jointOrder: H1_BEYOND_MIMIC_JOINT_ORDER },
    { label: 'H1-2', jointOrder: H1_2_BEYOND_MIMIC_JOINT_ORDER },
  ]) {
    it(`maps ${robotCase.label} BeyondMimic columns by the robot-specific order`, async () => {
      const service = new BeyondMimicMotionService();
      const fileMap = buildFileMap({
        [`motions/${robotCase.label}.npz`]: createBeyondMimicNpz(robotCase.jointOrder.length),
      });

      const result = await service.loadFromDroppedFiles(
        fileMap,
        buildSchema([...robotCase.jointOrder].reverse()),
      );

      expect(result.clip.schema.jointNames).toEqual([...robotCase.jointOrder]);
      expect(result.warnings.some((warning) => warning.includes(`${robotCase.label} joint order`))).toBe(true);
    });
  }

  it('exports edited clips back to BeyondMimic NPZ while preserving non-root body payloads', async () => {
    const service = new BeyondMimicMotionService();
    const fileMap = buildFileMap({
      'motions/h1_2_motion.npz': createBeyondMimicNpz(H1_2_BEYOND_MIMIC_JOINT_ORDER.length, 2),
    });

    const result = await service.loadFromDroppedFiles(
      fileMap,
      buildSchema(H1_2_BEYOND_MIMIC_JOINT_ORDER),
    );
    const secondFrameBase = result.clip.stride;
    result.clip.data[secondFrameBase] = 42;
    result.clip.data[secondFrameBase + 1] = 43;
    result.clip.data[secondFrameBase + 2] = 44;
    result.clip.data[secondFrameBase + 3] = 0;
    result.clip.data[secondFrameBase + 4] = 0;
    result.clip.data[secondFrameBase + 5] = Math.SQRT1_2;
    result.clip.data[secondFrameBase + 6] = Math.SQRT1_2;
    result.clip.data[secondFrameBase + DEFAULT_ROOT_COMPONENT_COUNT] = 12.5;

    const output = service.toNpz(result.clip);
    const archive = await parseNpzFile(new File([new Uint8Array(output)], 'modified_motion.npz'));
    expect(archive.listFileNames().sort()).toEqual([
      'body_ang_vel_w.npy',
      'body_lin_vel_w.npy',
      'body_pos_w.npy',
      'body_quat_w.npy',
      'fps.npy',
      'joint_pos.npy',
      'joint_vel.npy',
    ]);

    const jointPos = await archive.readNpy('joint_pos.npy');
    const jointVel = await archive.readNpy('joint_vel.npy');
    const bodyPos = await archive.readNpy('body_pos_w.npy');
    const bodyQuat = await archive.readNpy('body_quat_w.npy');
    const bodyLinVel = await archive.readNpy('body_lin_vel_w.npy');
    const bodyAngVel = await archive.readNpy('body_ang_vel_w.npy');

    expect(jointPos.shape).toEqual([2, H1_2_BEYOND_MIMIC_JOINT_ORDER.length]);
    expect(jointVel.shape).toEqual([2, H1_2_BEYOND_MIMIC_JOINT_ORDER.length]);
    expect(bodyPos.shape).toEqual([2, 2, 3]);
    expect(bodyQuat.shape).toEqual([2, 2, 4]);
    expect(bodyLinVel.shape).toEqual([2, 2, 3]);
    expect(bodyAngVel.shape).toEqual([2, 2, 3]);

    expect(jointPos.toNumberArray()[H1_2_BEYOND_MIMIC_JOINT_ORDER.length]).toBeCloseTo(12.5);
    expect(jointVel.toNumberArray()[H1_2_BEYOND_MIMIC_JOINT_ORDER.length]).toBeCloseTo((12.5 - 0.25) * 50);

    const bodyPosValues = bodyPos.toNumberArray();
    expect(bodyPosValues[6]).toBe(42);
    expect(bodyPosValues[7]).toBe(43);
    expect(bodyPosValues[8]).toBe(44);
    expect(bodyPosValues[9]).toBe(10);

    const bodyQuatValues = bodyQuat.toNumberArray();
    expect(bodyQuatValues[8]).toBeCloseTo(Math.SQRT1_2);
    expect(bodyQuatValues[9]).toBeCloseTo(0);
    expect(bodyQuatValues[10]).toBeCloseTo(0);
    expect(bodyQuatValues[11]).toBeCloseTo(Math.SQRT1_2);

    expect(bodyLinVel.toNumberArray()[6]).toBeCloseTo((42 - 1) * 50);
    expect(bodyAngVel.toNumberArray()[8]).toBeGreaterThan(0);
  });

  it('rejects BeyondMimic NPZ files whose joint count cannot match the active URDF', async () => {
    const service = new BeyondMimicMotionService();
    const fileMap = buildFileMap({
      'motions/h1_motion.npz': createBeyondMimicNpz(H1_BEYOND_MIMIC_JOINT_ORDER.length),
    });

    await expect(service.loadFromDroppedFiles(fileMap, buildSchema(['joint_a', 'joint_b']))).rejects.toThrow(
      /No BeyondMimic motion is compatible/,
    );
  });
});
