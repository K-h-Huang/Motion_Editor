import type {
  BeyondMimicMotionSource,
  DroppedFileMap,
  MotionClip,
  MotionSchema,
} from '../../types/viewer';
import {
  DEFAULT_ROOT_COMPONENT_COUNT,
  DEFAULT_MOTION_FPS,
  G1_BEYOND_MIMIC_JOINT_ORDER,
  H1_2_BEYOND_MIMIC_JOINT_ORDER,
  H1_BEYOND_MIMIC_JOINT_ORDER,
  hasSameJointSet,
} from './MotionSchema';
import { getBaseName, normalizePath } from '../urdf/pathResolver';
import { parseNpzFile, type NpzArchive, type ParsedNpyArray } from './NumpyIO';

const REQUIRED_BEYOND_MIMIC_ENTRIES = [
  'fps.npy',
  'joint_pos.npy',
  'body_pos_w.npy',
  'body_quat_w.npy',
] as const;

const BEYOND_MIMIC_NPZ_ENTRIES = [
  'fps.npy',
  'joint_pos.npy',
  'joint_vel.npy',
  'body_pos_w.npy',
  'body_quat_w.npy',
  'body_lin_vel_w.npy',
  'body_ang_vel_w.npy',
] as const;

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_COMPRESSION_STORE = 0;

interface ParsedBeyondMimicPayload {
  name: string;
  sourcePath: string;
  fps: number;
  frameCount: number;
  jointCount: number;
  bodyCount: number;
  jointPos: Float64Array;
  jointVel: Float64Array | null;
  bodyPosW: Float64Array;
  bodyQuatW: Float64Array;
  bodyLinVelW: Float64Array | null;
  bodyAngVelW: Float64Array | null;
  warnings: string[];
}

interface BeyondMimicJointOrderDefinition {
  label: string;
  jointNames: readonly string[];
}

interface ZipEntryInput {
  fileName: string;
  data: Uint8Array;
}

export interface BeyondMimicMotionLoadResult {
  clip: MotionClip;
  selectedMotionPath: string;
  warnings: string[];
}

const BEYOND_MIMIC_JOINT_ORDER_DEFINITIONS: BeyondMimicJointOrderDefinition[] = [
  { label: 'G1', jointNames: G1_BEYOND_MIMIC_JOINT_ORDER },
  { label: 'H1', jointNames: H1_BEYOND_MIMIC_JOINT_ORDER },
  { label: 'H1-2', jointNames: H1_2_BEYOND_MIMIC_JOINT_ORDER },
];

function buildClipName(path: string): string {
  const baseName = getBaseName(path);
  return baseName || 'motion.npz';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function cloneMotionSchema(motionSchema: MotionSchema, jointNames: readonly string[]): MotionSchema {
  return {
    rootJointName: motionSchema.rootJointName,
    rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
    jointNames: [...jointNames],
  };
}

function readFirstNumber(array: ParsedNpyArray, fallback: number): number {
  try {
    if (array.shape.length === 0) {
      return array.toScalarNumber();
    }

    const values = array.toNumberArray();
    const value = values[0];
    return Number.isFinite(value) ? Number(value) : fallback;
  } catch {
    return fallback;
  }
}

function ensureShape(
  shape: readonly number[],
  expectedRank: number,
  label: string,
): void {
  if (shape.length !== expectedRank) {
    throw new Error(
      `${label} must be rank ${expectedRank}, received shape [${shape.join(', ')}].`,
    );
  }
}

function ensureOptionalShape(
  array: ParsedNpyArray | null,
  expectedShape: readonly number[],
  label: string,
): Float64Array | null {
  if (!array) {
    return null;
  }

  if (
    array.shape.length !== expectedShape.length ||
    !array.shape.every((size, index) => size === expectedShape[index])
  ) {
    throw new Error(
      `${label} must have shape [${expectedShape.join(', ')}], received [${array.shape.join(', ')}].`,
    );
  }

  return array.toNumberArray();
}

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

function encodeAscii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createNpyFloat64(values: Float64Array, shape: number[]): Uint8Array {
  const elementCount = shape.length === 0
    ? 1
    : shape.reduce((product, size) => product * size, 1);
  if (elementCount !== values.length) {
    throw new Error(
      `Cannot export NPY shape [${shape.join(', ')}] with ${values.length} values.`,
    );
  }

  const shapeToken = shape.length === 0
    ? ''
    : shape.length === 1
      ? `${shape[0]},`
      : shape.join(', ');
  const headerBase = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shapeToken}), }`;
  const preambleLength = 10;
  const headerLengthWithoutPadding = headerBase.length + 1;
  const paddingSpaces = (16 - ((preambleLength + headerLengthWithoutPadding) % 16)) % 16;
  const header = `${headerBase}${' '.repeat(paddingSpaces)}\n`;
  const headerBytes = encodeAscii(header);

  const output = new Uint8Array(preambleLength + headerBytes.length + values.length * 8);
  output.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
  output[6] = 1;
  output[7] = 0;
  writeUint16(output, 8, headerBytes.length);
  output.set(headerBytes, preambleLength);

  const view = new DataView(output.buffer, output.byteOffset + preambleLength + headerBytes.length);
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat64(index * 8, values[index] ?? 0, true);
  }

  return output;
}

function createStoredNpz(entries: ZipEntryInput[]): Uint8Array {
  const localFileRecords: Uint8Array[] = [];
  const centralDirectoryRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileNameBytes = encodeAscii(entry.fileName);
    const crc = computeCrc32(entry.data);

    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    writeUint32(localHeader, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, ZIP_COMPRESSION_STORE);
    writeUint16(localHeader, 10, 0);
    writeUint16(localHeader, 12, 0);
    writeUint32(localHeader, 14, crc);
    writeUint32(localHeader, 18, entry.data.length);
    writeUint32(localHeader, 22, entry.data.length);
    writeUint16(localHeader, 26, fileNameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileNameBytes, 30);

    const localRecord = concatBytes([localHeader, entry.data]);
    localFileRecords.push(localRecord);

    const centralRecord = new Uint8Array(46 + fileNameBytes.length);
    writeUint32(centralRecord, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
    writeUint16(centralRecord, 4, 20);
    writeUint16(centralRecord, 6, 20);
    writeUint16(centralRecord, 8, 0);
    writeUint16(centralRecord, 10, ZIP_COMPRESSION_STORE);
    writeUint16(centralRecord, 12, 0);
    writeUint16(centralRecord, 14, 0);
    writeUint32(centralRecord, 16, crc);
    writeUint32(centralRecord, 20, entry.data.length);
    writeUint32(centralRecord, 24, entry.data.length);
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

function resolveJointOrder(
  payloadJointCount: number,
  motionSchema: MotionSchema,
): {
  jointNames: string[];
  label: string | null;
} | null {
  for (const definition of BEYOND_MIMIC_JOINT_ORDER_DEFINITIONS) {
    if (
      payloadJointCount === definition.jointNames.length &&
      hasSameJointSet(motionSchema.jointNames, definition.jointNames)
    ) {
      return {
        jointNames: [...definition.jointNames],
        label: definition.label,
      };
    }
  }

  if (payloadJointCount === motionSchema.jointNames.length) {
    return {
      jointNames: [...motionSchema.jointNames],
      label: null,
    };
  }

  return null;
}

function hasRequiredBeyondMimicEntries(archive: NpzArchive): boolean {
  return REQUIRED_BEYOND_MIMIC_ENTRIES.every((entry) => archive.hasFile(entry));
}

async function parseBeyondMimicPayload(
  file: File,
  sourcePath: string,
): Promise<ParsedBeyondMimicPayload> {
  const archive = await parseNpzFile(file);
  if (!hasRequiredBeyondMimicEntries(archive)) {
    throw new Error(
      'BeyondMimic NPZ is missing required entries: fps, joint_pos, body_pos_w, body_quat_w.',
    );
  }

  const fpsRaw = await archive.readNpy('fps.npy');
  const jointPosRaw = await archive.readNpy('joint_pos.npy');
  const bodyPosRaw = await archive.readNpy('body_pos_w.npy');
  const bodyQuatRaw = await archive.readNpy('body_quat_w.npy');
  const jointVelRaw = archive.hasFile('joint_vel.npy')
    ? await archive.readNpy('joint_vel.npy')
    : null;
  const bodyLinVelRaw = archive.hasFile('body_lin_vel_w.npy')
    ? await archive.readNpy('body_lin_vel_w.npy')
    : null;
  const bodyAngVelRaw = archive.hasFile('body_ang_vel_w.npy')
    ? await archive.readNpy('body_ang_vel_w.npy')
    : null;

  ensureShape(jointPosRaw.shape, 2, 'BeyondMimic joint_pos.npy');
  ensureShape(bodyPosRaw.shape, 3, 'BeyondMimic body_pos_w.npy');
  ensureShape(bodyQuatRaw.shape, 3, 'BeyondMimic body_quat_w.npy');

  const frameCount = jointPosRaw.shape[0] ?? 0;
  const jointCount = jointPosRaw.shape[1] ?? 0;
  const bodyFrameCount = bodyPosRaw.shape[0] ?? 0;
  const bodyCount = bodyPosRaw.shape[1] ?? 0;
  const bodyPosStride = bodyPosRaw.shape[2] ?? 0;
  const quatFrameCount = bodyQuatRaw.shape[0] ?? 0;
  const quatBodyCount = bodyQuatRaw.shape[1] ?? 0;
  const bodyQuatStride = bodyQuatRaw.shape[2] ?? 0;

  if (frameCount <= 0 || jointCount <= 0) {
    throw new Error('BeyondMimic joint_pos.npy has no motion frames or joints.');
  }
  if (bodyFrameCount !== frameCount || quatFrameCount !== frameCount) {
    throw new Error(
      `BeyondMimic frame count mismatch: joint_pos=${frameCount}, body_pos_w=${bodyFrameCount}, body_quat_w=${quatFrameCount}.`,
    );
  }
  if (bodyCount <= 0 || quatBodyCount <= 0 || bodyCount !== quatBodyCount) {
    throw new Error(
      `BeyondMimic body count mismatch: body_pos_w=${bodyCount}, body_quat_w=${quatBodyCount}.`,
    );
  }
  if (bodyPosStride !== 3) {
    throw new Error(
      `BeyondMimic body_pos_w.npy must have shape [frames, bodies, 3], received [${bodyPosRaw.shape.join(', ')}].`,
    );
  }
  if (bodyQuatStride !== 4) {
    throw new Error(
      `BeyondMimic body_quat_w.npy must have shape [frames, bodies, 4], received [${bodyQuatRaw.shape.join(', ')}].`,
    );
  }

  const jointVel = ensureOptionalShape(
    jointVelRaw,
    [frameCount, jointCount],
    'BeyondMimic joint_vel.npy',
  );
  const bodyLinVelW = ensureOptionalShape(
    bodyLinVelRaw,
    [frameCount, bodyCount, 3],
    'BeyondMimic body_lin_vel_w.npy',
  );
  const bodyAngVelW = ensureOptionalShape(
    bodyAngVelRaw,
    [frameCount, bodyCount, 3],
    'BeyondMimic body_ang_vel_w.npy',
  );

  const warnings: string[] = [];
  const parsedFps = readFirstNumber(fpsRaw, DEFAULT_MOTION_FPS);
  const fps = Number.isFinite(parsedFps) && parsedFps > 0 ? parsedFps : DEFAULT_MOTION_FPS;
  if (fps !== parsedFps) {
    warnings.push(
      `BeyondMimic motion "${sourcePath}" has invalid fps; defaulted to ${DEFAULT_MOTION_FPS}.`,
    );
  }

  return {
    name: buildClipName(sourcePath),
    sourcePath,
    fps,
    frameCount,
    jointCount,
    bodyCount,
    jointPos: jointPosRaw.toNumberArray(),
    jointVel,
    bodyPosW: bodyPosRaw.toNumberArray(),
    bodyQuatW: bodyQuatRaw.toNumberArray(),
    bodyLinVelW,
    bodyAngVelW,
    warnings,
  };
}

function buildMotionClip(
  payload: ParsedBeyondMimicPayload,
  motionSchema: MotionSchema,
): MotionClip {
  const resolved = resolveJointOrder(payload.jointCount, motionSchema);
  if (!resolved) {
    throw new Error(
      `BeyondMimic motion "${payload.sourcePath}" has ${payload.jointCount} joints, expected ${motionSchema.jointNames.length} for the active URDF.`,
    );
  }

  const schema = cloneMotionSchema(motionSchema, resolved.jointNames);
  const stride = DEFAULT_ROOT_COMPONENT_COUNT + payload.jointCount;
  const data = new Float32Array(payload.frameCount * stride);

  for (let frameIndex = 0; frameIndex < payload.frameCount; frameIndex += 1) {
    const targetBase = frameIndex * stride;
    const jointBase = frameIndex * payload.jointCount;
    const rootPosBase = frameIndex * payload.bodyCount * 3;
    const rootQuatBase = frameIndex * payload.bodyCount * 4;

    data[targetBase] = payload.bodyPosW[rootPosBase] ?? 0;
    data[targetBase + 1] = payload.bodyPosW[rootPosBase + 1] ?? 0;
    data[targetBase + 2] = payload.bodyPosW[rootPosBase + 2] ?? 0;

    let qw = payload.bodyQuatW[rootQuatBase] ?? 1;
    let qx = payload.bodyQuatW[rootQuatBase + 1] ?? 0;
    let qy = payload.bodyQuatW[rootQuatBase + 2] ?? 0;
    let qz = payload.bodyQuatW[rootQuatBase + 3] ?? 0;
    const qLen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (qLen < 1e-10) {
      qx = 0;
      qy = 0;
      qz = 0;
      qw = 1;
    } else {
      qx /= qLen;
      qy /= qLen;
      qz /= qLen;
      qw /= qLen;
    }

    data[targetBase + 3] = qx;
    data[targetBase + 4] = qy;
    data[targetBase + 5] = qz;
    data[targetBase + 6] = qw;

    for (let jointIndex = 0; jointIndex < payload.jointCount; jointIndex += 1) {
      data[targetBase + DEFAULT_ROOT_COMPONENT_COUNT + jointIndex] =
        payload.jointPos[jointBase + jointIndex] ?? 0;
    }
  }

  return {
    name: payload.name,
    sourcePath: payload.sourcePath,
    fps: payload.fps,
    frameCount: payload.frameCount,
    stride,
    schema,
    csvMode: 'ordered',
    sourceColumnCount: stride,
    data,
    beyondMimicSource: {
      frameCount: payload.frameCount,
      jointCount: payload.jointCount,
      bodyCount: payload.bodyCount,
      jointVel: payload.jointVel ?? undefined,
      bodyPosW: payload.bodyPosW,
      bodyQuatW: payload.bodyQuatW,
      bodyLinVelW: payload.bodyLinVelW ?? undefined,
      bodyAngVelW: payload.bodyAngVelW ?? undefined,
    },
  };
}

function normalizeQuaternionXyzw(
  qxRaw: number,
  qyRaw: number,
  qzRaw: number,
  qwRaw: number,
): [number, number, number, number] {
  let qx = Number.isFinite(qxRaw) ? qxRaw : 0;
  let qy = Number.isFinite(qyRaw) ? qyRaw : 0;
  let qz = Number.isFinite(qzRaw) ? qzRaw : 0;
  let qw = Number.isFinite(qwRaw) ? qwRaw : 1;
  const length = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (length < 1e-10) {
    return [0, 0, 0, 1];
  }
  return [qx / length, qy / length, qz / length, qw / length];
}

function readClipRootQuatWxyz(clip: MotionClip, frameIndex: number): [number, number, number, number] {
  const base = frameIndex * clip.stride;
  const [qx, qy, qz, qw] = normalizeQuaternionXyzw(
    clip.data[base + 3] ?? 0,
    clip.data[base + 4] ?? 0,
    clip.data[base + 5] ?? 0,
    clip.data[base + 6] ?? 1,
  );
  return [qw, qx, qy, qz];
}

function multiplyQuatWxyz(
  left: [number, number, number, number],
  right: [number, number, number, number],
): [number, number, number, number] {
  const [aw, ax, ay, az] = left;
  const [bw, bx, by, bz] = right;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

function conjugateQuatWxyz(
  quat: [number, number, number, number],
): [number, number, number, number] {
  return [quat[0], -quat[1], -quat[2], -quat[3]];
}

function normalizeQuaternionWxyz(
  quat: [number, number, number, number],
): [number, number, number, number] {
  let [qw, qx, qy, qz] = quat;
  const length = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
  if (length < 1e-10) {
    return [1, 0, 0, 0];
  }
  qw /= length;
  qx /= length;
  qy /= length;
  qz /= length;
  if (qw < 0) {
    return [-qw, -qx, -qy, -qz];
  }
  return [qw, qx, qy, qz];
}

function finiteDifference(
  data: Float32Array,
  frameIndex: number,
  frameCount: number,
  stride: number,
  componentOffset: number,
  fps: number,
): number {
  if (frameCount <= 1 || fps <= 0) {
    return 0;
  }

  const previousFrame = frameIndex <= 0 ? frameIndex : frameIndex - 1;
  const nextFrame = frameIndex >= frameCount - 1 ? frameIndex : frameIndex + 1;
  const frameDelta = nextFrame - previousFrame;
  if (frameDelta <= 0) {
    return 0;
  }

  const previous = data[previousFrame * stride + componentOffset] ?? 0;
  const next = data[nextFrame * stride + componentOffset] ?? 0;
  return ((next - previous) * fps) / frameDelta;
}

function computeRootAngularVelocity(
  clip: MotionClip,
  frameIndex: number,
  fps: number,
): [number, number, number] {
  if (clip.frameCount <= 1 || fps <= 0) {
    return [0, 0, 0];
  }

  const previousFrame = frameIndex <= 0 ? frameIndex : frameIndex - 1;
  const nextFrame = frameIndex >= clip.frameCount - 1 ? frameIndex : frameIndex + 1;
  const frameDelta = nextFrame - previousFrame;
  if (frameDelta <= 0) {
    return [0, 0, 0];
  }

  const previousQuat = readClipRootQuatWxyz(clip, previousFrame);
  const nextQuat = readClipRootQuatWxyz(clip, nextFrame);
  const relativeQuat = normalizeQuaternionWxyz(
    multiplyQuatWxyz(nextQuat, conjugateQuatWxyz(previousQuat)),
  );
  const [, qx, qy, qz] = relativeQuat;
  const vectorLength = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (vectorLength < 1e-10) {
    return [0, 0, 0];
  }

  const dt = frameDelta / fps;
  const angle = 2 * Math.atan2(vectorLength, relativeQuat[0]);
  const scale = angle / (dt * vectorLength);
  return [qx * scale, qy * scale, qz * scale];
}

function hasExpectedSourceArrayLength(
  array: Float64Array | undefined,
  expectedLength: number,
): array is Float64Array {
  return Boolean(array && array.length === expectedLength);
}

function getReusableBeyondMimicSource(clip: MotionClip): BeyondMimicMotionSource | null {
  const source = clip.beyondMimicSource;
  if (!source || source.frameCount !== clip.frameCount || source.bodyCount <= 0) {
    return null;
  }

  const posLength = clip.frameCount * source.bodyCount * 3;
  const quatLength = clip.frameCount * source.bodyCount * 4;
  if (
    !hasExpectedSourceArrayLength(source.bodyPosW, posLength) ||
    !hasExpectedSourceArrayLength(source.bodyQuatW, quatLength)
  ) {
    return null;
  }

  return source;
}

function buildJointPositionArray(clip: MotionClip, jointCount: number): Float64Array {
  const values = new Float64Array(clip.frameCount * jointCount);
  for (let frameIndex = 0; frameIndex < clip.frameCount; frameIndex += 1) {
    const sourceBase = frameIndex * clip.stride + DEFAULT_ROOT_COMPONENT_COUNT;
    const targetBase = frameIndex * jointCount;
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      values[targetBase + jointIndex] = clip.data[sourceBase + jointIndex] ?? 0;
    }
  }
  return values;
}

function buildJointVelocityArray(clip: MotionClip, jointCount: number, fps: number): Float64Array {
  const values = new Float64Array(clip.frameCount * jointCount);
  for (let frameIndex = 0; frameIndex < clip.frameCount; frameIndex += 1) {
    const targetBase = frameIndex * jointCount;
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      values[targetBase + jointIndex] = finiteDifference(
        clip.data,
        frameIndex,
        clip.frameCount,
        clip.stride,
        DEFAULT_ROOT_COMPONENT_COUNT + jointIndex,
        fps,
      );
    }
  }
  return values;
}

function buildBodyArrays(
  clip: MotionClip,
  fps: number,
): {
  bodyCount: number;
  bodyPosW: Float64Array;
  bodyQuatW: Float64Array;
  bodyLinVelW: Float64Array;
  bodyAngVelW: Float64Array;
} {
  const source = getReusableBeyondMimicSource(clip);
  const bodyCount = source?.bodyCount ?? 1;
  const bodyPosLength = clip.frameCount * bodyCount * 3;
  const bodyQuatLength = clip.frameCount * bodyCount * 4;
  const bodyPosW = source
    ? new Float64Array(source.bodyPosW)
    : new Float64Array(bodyPosLength);
  const bodyQuatW = source
    ? new Float64Array(source.bodyQuatW)
    : new Float64Array(bodyQuatLength);
  const bodyLinVelW = hasExpectedSourceArrayLength(source?.bodyLinVelW, bodyPosLength)
    ? new Float64Array(source.bodyLinVelW)
    : new Float64Array(bodyPosLength);
  const bodyAngVelW = hasExpectedSourceArrayLength(source?.bodyAngVelW, bodyPosLength)
    ? new Float64Array(source.bodyAngVelW)
    : new Float64Array(bodyPosLength);

  if (!source) {
    for (let frameIndex = 0; frameIndex < clip.frameCount; frameIndex += 1) {
      const quatBase = frameIndex * bodyCount * 4;
      bodyQuatW[quatBase] = 1;
    }
  }

  for (let frameIndex = 0; frameIndex < clip.frameCount; frameIndex += 1) {
    const clipBase = frameIndex * clip.stride;
    const posBase = frameIndex * bodyCount * 3;
    const quatBase = frameIndex * bodyCount * 4;

    bodyPosW[posBase] = clip.data[clipBase] ?? 0;
    bodyPosW[posBase + 1] = clip.data[clipBase + 1] ?? 0;
    bodyPosW[posBase + 2] = clip.data[clipBase + 2] ?? 0;

    const [qw, qx, qy, qz] = readClipRootQuatWxyz(clip, frameIndex);
    bodyQuatW[quatBase] = qw;
    bodyQuatW[quatBase + 1] = qx;
    bodyQuatW[quatBase + 2] = qy;
    bodyQuatW[quatBase + 3] = qz;

    bodyLinVelW[posBase] = finiteDifference(
      clip.data,
      frameIndex,
      clip.frameCount,
      clip.stride,
      0,
      fps,
    );
    bodyLinVelW[posBase + 1] = finiteDifference(
      clip.data,
      frameIndex,
      clip.frameCount,
      clip.stride,
      1,
      fps,
    );
    bodyLinVelW[posBase + 2] = finiteDifference(
      clip.data,
      frameIndex,
      clip.frameCount,
      clip.stride,
      2,
      fps,
    );

    const [angX, angY, angZ] = computeRootAngularVelocity(clip, frameIndex, fps);
    bodyAngVelW[posBase] = angX;
    bodyAngVelW[posBase + 1] = angY;
    bodyAngVelW[posBase + 2] = angZ;
  }

  return {
    bodyCount,
    bodyPosW,
    bodyQuatW,
    bodyLinVelW,
    bodyAngVelW,
  };
}

export class BeyondMimicMotionService {
  toNpz(clip: MotionClip): Uint8Array {
    const jointCount = clip.schema.jointNames.length;
    if (clip.frameCount <= 0 || jointCount <= 0) {
      throw new Error('Cannot export an empty BeyondMimic motion.');
    }
    if (clip.schema.rootComponentCount !== DEFAULT_ROOT_COMPONENT_COUNT) {
      throw new Error(
        `Cannot export BeyondMimic motion with root component count ${clip.schema.rootComponentCount}.`,
      );
    }
    if (clip.stride < DEFAULT_ROOT_COMPONENT_COUNT + jointCount) {
      throw new Error(
        `Cannot export BeyondMimic motion: clip stride ${clip.stride} is smaller than expected ${DEFAULT_ROOT_COMPONENT_COUNT + jointCount}.`,
      );
    }

    const fps = Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : DEFAULT_MOTION_FPS;
    const jointPos = buildJointPositionArray(clip, jointCount);
    const jointVel = buildJointVelocityArray(clip, jointCount, fps);
    const bodyArrays = buildBodyArrays(clip, fps);

    const payloads: Record<(typeof BEYOND_MIMIC_NPZ_ENTRIES)[number], { values: Float64Array; shape: number[] }> = {
      'fps.npy': {
        values: new Float64Array([fps]),
        shape: [1],
      },
      'joint_pos.npy': {
        values: jointPos,
        shape: [clip.frameCount, jointCount],
      },
      'joint_vel.npy': {
        values: jointVel,
        shape: [clip.frameCount, jointCount],
      },
      'body_pos_w.npy': {
        values: bodyArrays.bodyPosW,
        shape: [clip.frameCount, bodyArrays.bodyCount, 3],
      },
      'body_quat_w.npy': {
        values: bodyArrays.bodyQuatW,
        shape: [clip.frameCount, bodyArrays.bodyCount, 4],
      },
      'body_lin_vel_w.npy': {
        values: bodyArrays.bodyLinVelW,
        shape: [clip.frameCount, bodyArrays.bodyCount, 3],
      },
      'body_ang_vel_w.npy': {
        values: bodyArrays.bodyAngVelW,
        shape: [clip.frameCount, bodyArrays.bodyCount, 3],
      },
    };

    return createStoredNpz(
      BEYOND_MIMIC_NPZ_ENTRIES.map((fileName) => ({
        fileName,
        data: createNpyFloat64(payloads[fileName].values, payloads[fileName].shape),
      })),
    );
  }

  async getAvailableNpzPaths(fileMap: DroppedFileMap): Promise<string[]> {
    const npzPaths = [...fileMap.keys()]
      .map((path) => normalizePath(path))
      .filter((path) => path.toLowerCase().endsWith('.npz'))
      .sort((left, right) => left.localeCompare(right));

    const supportedPaths: string[] = [];
    for (const path of npzPaths) {
      const file = fileMap.get(path);
      if (!file) {
        continue;
      }

      try {
        const archive = await parseNpzFile(file);
        if (hasRequiredBeyondMimicEntries(archive)) {
          supportedPaths.push(path);
        }
      } catch {
        // Keep scanning other NPZ files; SMPL/unknown NPZ handling happens elsewhere.
      }
    }

    return supportedPaths;
  }

  async loadFromDroppedFiles(
    fileMap: DroppedFileMap,
    motionSchema: MotionSchema,
    preferredMotionPath?: string,
  ): Promise<BeyondMimicMotionLoadResult> {
    const npzPaths = await this.getAvailableNpzPaths(fileMap);
    if (npzPaths.length === 0) {
      throw new Error('No BeyondMimic motion .npz found. Drop a motion .npz file.');
    }

    const warnings = new Set<string>();

    const loadPath = async (path: string): Promise<ParsedBeyondMimicPayload> => {
      const file = fileMap.get(path);
      if (!file) {
        throw new Error(`Selected BeyondMimic motion is missing from file map: ${path}`);
      }
      return parseBeyondMimicPayload(file, path);
    };

    if (preferredMotionPath) {
      const normalizedPreferredPath = normalizePath(preferredMotionPath);
      const selectedPath = npzPaths.find((path) => path === normalizedPreferredPath) ?? null;
      if (!selectedPath) {
        throw new Error(`Requested BeyondMimic motion not found: ${preferredMotionPath}`);
      }

      const payload = await loadPath(selectedPath);
      for (const warning of payload.warnings) {
        warnings.add(warning);
      }

      const resolved = resolveJointOrder(payload.jointCount, motionSchema);
      if (resolved?.label) {
        warnings.add(
          `Mapped BeyondMimic joint_pos columns using ${resolved.label} joint order.`,
        );
      }

      return {
        clip: buildMotionClip(payload, motionSchema),
        selectedMotionPath: selectedPath,
        warnings: [...warnings],
      };
    }

    const discoveredJointCounts = new Set<number>();
    let invalidFileCount = 0;
    let selectedPath: string | null = null;
    let selectedPayload: ParsedBeyondMimicPayload | null = null;
    let selectedMappingLabel: string | null = null;
    let firstParseError: string | null = null;

    for (const path of npzPaths) {
      try {
        const payload = await loadPath(path);
        discoveredJointCounts.add(payload.jointCount);
        const resolved = resolveJointOrder(payload.jointCount, motionSchema);
        if (!resolved) {
          continue;
        }

        selectedPath = path;
        selectedPayload = payload;
        selectedMappingLabel = resolved.label;
        break;
      } catch (error) {
        invalidFileCount += 1;
        firstParseError ??= toErrorMessage(error);
      }
    }

    if (!selectedPath || !selectedPayload) {
      if (discoveredJointCounts.size > 0) {
        throw new Error(
          `No BeyondMimic motion is compatible with the active URDF. Expected ${motionSchema.jointNames.length} joints, found ${[...discoveredJointCounts].sort((left, right) => left - right).join(', ')}.`,
        );
      }

      throw new Error(firstParseError ?? 'No valid BeyondMimic motion .npz found.');
    }

    if (invalidFileCount > 0) {
      warnings.add(
        `Ignored ${invalidFileCount} unsupported .npz file${invalidFileCount > 1 ? 's' : ''} while scanning for BeyondMimic motions.`,
      );
    }

    for (const warning of selectedPayload.warnings) {
      warnings.add(warning);
    }
    if (selectedMappingLabel) {
      warnings.add(
        `Mapped BeyondMimic joint_pos columns using ${selectedMappingLabel} joint order.`,
      );
    }
    if (npzPaths.length > 1) {
      warnings.add(
        `Multiple BeyondMimic motion files found. Auto-selected ${selectedPath}.`,
      );
    }

    return {
      clip: buildMotionClip(selectedPayload, motionSchema),
      selectedMotionPath: selectedPath,
      warnings: [...warnings],
    };
  }
}
