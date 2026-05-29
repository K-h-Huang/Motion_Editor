import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ROOT_COMPONENT_COUNT,
  DEFAULT_ROOT_JOINT_NAME,
} from '../io/motion/MotionSchema';
import type { MotionClip, MotionSchema, UrdfRobotLike } from '../types/viewer';
import { G1MotionPlayer } from './G1MotionPlayer';

interface CapturedJointCall {
  jointName: string;
  values: number[];
}

type RafCallback = (timestamp: number) => void;

const TEST_JOINT_NAMES = ['joint_a', 'joint_b', 'joint_c'];
const TEST_MOTION_SCHEMA: MotionSchema = {
  rootJointName: DEFAULT_ROOT_JOINT_NAME,
  rootComponentCount: DEFAULT_ROOT_COMPONENT_COUNT,
  jointNames: [...TEST_JOINT_NAMES],
};

function createClip(frameCount: number, schema: MotionSchema = TEST_MOTION_SCHEMA): MotionClip {
  const stride = schema.rootComponentCount + schema.jointNames.length;
  const data = new Float32Array(frameCount * stride);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * stride;
    data[base] = frame + 0.1;
    data[base + 1] = frame + 0.2;
    data[base + 2] = frame + 0.3;
    data[base + 3] = 0;
    data[base + 4] = 0;
    data[base + 5] = 0;
    data[base + 6] = 1;

    for (let jointIndex = 0; jointIndex < schema.jointNames.length; jointIndex += 1) {
      data[base + schema.rootComponentCount + jointIndex] = frame * 10 + jointIndex;
    }
  }

  return {
    name: 'test.csv',
    sourcePath: 'motions/test.csv',
    fps: 30,
    frameCount,
    stride,
    schema: {
      rootJointName: schema.rootJointName,
      rootComponentCount: schema.rootComponentCount,
      jointNames: [...schema.jointNames],
    },
    csvMode: 'ordered',
    sourceColumnCount: stride,
    data,
  };
}

function expectArrayCloseTo(actual: ArrayLike<number>, expected: readonly number[], precision = 5): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, precision);
  });
}

function createMockRobot(options: {
  includeRoot?: boolean;
  rootJointName?: string;
  jointNames?: readonly string[];
  includeTransform?: boolean;
  initialPosition?: any;
  initialQuaternion?: any;
} = {}): {
  robot: UrdfRobotLike;
  calls: CapturedJointCall[];
  initialPosition: any;
  initialQuaternion: any;
} {
  const includeRoot = options.includeRoot ?? true;
  const rootJointName = options.rootJointName ?? DEFAULT_ROOT_JOINT_NAME;
  const jointNames = options.jointNames ?? TEST_JOINT_NAMES;
  const includeTransform = options.includeTransform ?? false;
  const calls: CapturedJointCall[] = [];
  const joints: Record<string, {}> = {};

  if (includeRoot) {
    joints[rootJointName] = {};
  }

  for (const jointName of jointNames) {
    joints[jointName] = {};
  }

  const robot: UrdfRobotLike = {
    name: 'test-robot',
    joints,
    setJointValue: (jointName, ...values) => {
      calls.push({ jointName, values });
      return Boolean(joints[jointName]);
    },
    traverse: () => {
      // no-op for tests
    },
  };

  const initialPosition = options.initialPosition?.clone() ?? new Vector3();
  const initialQuaternion = options.initialQuaternion?.clone() ?? new Quaternion();

  if (includeTransform) {
    const robotWithTransform = robot as UrdfRobotLike & {
      position: any;
      quaternion: any;
    };
    robotWithTransform.position = initialPosition.clone();
    robotWithTransform.quaternion = initialQuaternion.clone();
  }

  return { robot, calls, initialPosition, initialQuaternion };
}

describe('G1MotionPlayer', () => {
  it('clamps seek bounds and applies exact frame values', () => {
    const { robot, calls } = createMockRobot();
    const clip = createClip(2);
    const player = new G1MotionPlayer();
    const frameIndices: number[] = [];

    player.onFrameChanged = (snapshot) => frameIndices.push(snapshot.frameIndex);
    player.attachRobot(robot);
    player.loadClip(clip);
    player.seek(-100);
    player.seek(100);

    expect(frameIndices).toEqual([0, 0, 1]);
    expect(calls).toHaveLength((TEST_JOINT_NAMES.length + 1) * 3);

    const rootCalls = calls.filter((call) => call.jointName === DEFAULT_ROOT_JOINT_NAME);
    expect(rootCalls).toHaveLength(3);
    expect(rootCalls[2]?.values[0]).toBeCloseTo(1.1);
    expect(rootCalls[2]?.values[1]).toBeCloseTo(1.2);
    expect(rootCalls[2]?.values[2]).toBeCloseTo(1.3);
  });

  it('can sample a frame without emitting frame callbacks and restores the current frame', () => {
    const { robot } = createMockRobot();
    const clip = createClip(3);
    const player = new G1MotionPlayer();
    const frameIndices: number[] = [];

    player.onFrameChanged = (snapshot) => frameIndices.push(snapshot.frameIndex);
    player.attachRobot(robot);
    player.loadClip(clip);
    player.seek(1);

    const sampledRootX = player.withFrameAppliedSilently(2, () => player.getRootPosition().x);

    expect(sampledRootX).toBeCloseTo(2.1);
    expect(player.getCurrentFrame()).toBe(1);
    expect(player.getRootPosition().x).toBeCloseTo(1.1);
    expect(frameIndices).toEqual([0, 1]);
  });

  it('converts root quaternion into XYZ Euler before applying floating joint', () => {
    const { robot, calls } = createMockRobot();
    const clip = createClip(1);
    const expectedEuler = new Euler(0.6, -0.35, 0.4, 'XYZ');
    const quat = new Quaternion().setFromEuler(expectedEuler);
    clip.data[3] = quat.x;
    clip.data[4] = quat.y;
    clip.data[5] = quat.z;
    clip.data[6] = quat.w;

    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    const rootCalls = calls.filter((call) => call.jointName === DEFAULT_ROOT_JOINT_NAME);
    expect(rootCalls).toHaveLength(1);
    const values = rootCalls[0]?.values ?? [];
    expect(values[3]).toBeCloseTo(expectedEuler.x, 5);
    expect(values[4]).toBeCloseTo(expectedEuler.y, 5);
    expect(values[5]).toBeCloseTo(expectedEuler.z, 5);
  });

  it('reports missing joints and missing root based on loaded clip schema', () => {
    const { robot } = createMockRobot({
      includeRoot: false,
      jointNames: TEST_JOINT_NAMES.slice(2),
    });
    const player = new G1MotionPlayer();
    player.attachRobot(robot);

    const report = player.loadClip(createClip(1));

    expect(report.missingRequiredJoints).toEqual([
      TEST_JOINT_NAMES[0],
      TEST_JOINT_NAMES[1],
    ]);
    expect(report.missingRootJoint).toBe(true);
  });

  it('falls back to robot transform root motion when floating joint is missing', () => {
    const rootEuler = new Euler(0.35, -0.22, 0.18, 'XYZ');
    const rootQuat = new Quaternion().setFromEuler(rootEuler);
    const basePosition = new Vector3(0.4, -0.15, 0.8);
    const baseQuaternion = new Quaternion().setFromEuler(new Euler(0.1, 0.03, -0.07, 'XYZ'));
    const { robot, calls, initialPosition, initialQuaternion } = createMockRobot({
      includeRoot: false,
      includeTransform: true,
      initialPosition: basePosition,
      initialQuaternion: baseQuaternion,
    });
    const clip = createClip(1);
    clip.data[0] = 1.2;
    clip.data[1] = -0.6;
    clip.data[2] = 0.5;
    clip.data[3] = rootQuat.x;
    clip.data[4] = rootQuat.y;
    clip.data[5] = rootQuat.z;
    clip.data[6] = rootQuat.w;

    const warnings: string[] = [];
    const player = new G1MotionPlayer();
    player.onWarning = (warning) => warnings.push(warning);
    player.attachRobot(robot);
    const report = player.loadClip(clip);

    expect(report.missingRootJoint).toBe(false);
    expect(report.usesRootTransformFallback).toBe(true);
    expect(warnings).toEqual([]);
    expect(calls.some((call) => call.jointName === DEFAULT_ROOT_JOINT_NAME)).toBe(false);

    const robotWithTransform = robot as UrdfRobotLike & {
      position: any;
      quaternion: any;
    };
    const expectedPosition = initialPosition.clone().applyQuaternion(rootQuat).add(new Vector3(1.2, -0.6, 0.5));
    const expectedQuaternion = rootQuat.clone().multiply(initialQuaternion);

    expect(robotWithTransform.position.x).toBeCloseTo(expectedPosition.x, 5);
    expect(robotWithTransform.position.y).toBeCloseTo(expectedPosition.y, 5);
    expect(robotWithTransform.position.z).toBeCloseTo(expectedPosition.z, 5);
    expect(robotWithTransform.quaternion.x).toBeCloseTo(expectedQuaternion.x, 5);
    expect(robotWithTransform.quaternion.y).toBeCloseTo(expectedQuaternion.y, 5);
    expect(robotWithTransform.quaternion.z).toBeCloseTo(expectedQuaternion.z, 5);
    expect(robotWithTransform.quaternion.w).toBeCloseTo(expectedQuaternion.w, 5);
  });

  it('keeps fallback root anchor stable across multiple csv loads on the same robot', () => {
    const { robot, initialPosition } = createMockRobot({
      includeRoot: false,
      includeTransform: true,
      initialPosition: new Vector3(0.25, -0.1, 0.6),
    });
    const firstClip = createClip(1);
    const secondClip = createClip(1);
    firstClip.data[0] = 1.0;
    firstClip.data[1] = 0.0;
    firstClip.data[2] = 0.0;
    secondClip.data[0] = 2.0;
    secondClip.data[1] = 0.0;
    secondClip.data[2] = 0.0;

    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(firstClip);

    // Mimic App flow: dropping another CSV re-attaches the same robot before loading.
    player.attachRobot(robot);
    player.loadClip(secondClip);

    const robotWithTransform = robot as UrdfRobotLike & {
      position: any;
    };
    expect(robotWithTransform.position.x).toBeCloseTo(initialPosition.x + 2.0, 5);
    expect(robotWithTransform.position.y).toBeCloseTo(initialPosition.y, 5);
    expect(robotWithTransform.position.z).toBeCloseTo(initialPosition.z, 5);
  });

  it('resets fallback root transform before restoring a clip on the same robot', () => {
    const { robot, initialPosition, initialQuaternion } = createMockRobot({
      includeRoot: false,
      includeTransform: true,
      initialPosition: new Vector3(0.25, -0.1, 0.6),
      initialQuaternion: new Quaternion().setFromEuler(new Euler(0.12, -0.05, 0.08, 'XYZ')),
    });
    const offsetEuler = new Euler(0.18, -0.11, 0.24, 'XYZ');
    const offsetQuat = new Quaternion().setFromEuler(offsetEuler);
    const offsetClip = createClip(1);
    offsetClip.data[0] = 1.5;
    offsetClip.data[1] = -0.4;
    offsetClip.data[2] = 0.9;
    offsetClip.data[3] = offsetQuat.x;
    offsetClip.data[4] = offsetQuat.y;
    offsetClip.data[5] = offsetQuat.z;
    offsetClip.data[6] = offsetQuat.w;

    const restoredClip = createClip(1);
    restoredClip.data[0] = 0;
    restoredClip.data[1] = 0;
    restoredClip.data[2] = 0;
    restoredClip.data[3] = 0;
    restoredClip.data[4] = 0;
    restoredClip.data[5] = 0;
    restoredClip.data[6] = 1;

    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(offsetClip);

    player.attachRobot(robot);
    player.loadClip(restoredClip);

    const robotWithTransform = robot as UrdfRobotLike & {
      position: any;
      quaternion: any;
    };
    expect(robotWithTransform.position.x).toBeCloseTo(initialPosition.x, 5);
    expect(robotWithTransform.position.y).toBeCloseTo(initialPosition.y, 5);
    expect(robotWithTransform.position.z).toBeCloseTo(initialPosition.z, 5);
    expect(robotWithTransform.quaternion.x).toBeCloseTo(initialQuaternion.x, 5);
    expect(robotWithTransform.quaternion.y).toBeCloseTo(initialQuaternion.y, 5);
    expect(robotWithTransform.quaternion.z).toBeCloseTo(initialQuaternion.z, 5);
    expect(robotWithTransform.quaternion.w).toBeCloseTo(initialQuaternion.w, 5);
  });

  it('exposes editable curve channels for root and joints', () => {
    const { robot } = createMockRobot();
    const clip = createClip(3);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    const channels = player.getCurveChannels();
    expect(channels.map((channel) => channel.id)).toEqual([
      'root_position:x',
      'root_position:y',
      'root_position:z',
      'root_rotation:roll',
      'root_rotation:pitch',
      'root_rotation:yaw',
      'joint:joint_a',
      'joint:joint_b',
      'joint:joint_c',
    ]);

    const jointValues = player.getChannelValues('joint:joint_b');
    expect([...jointValues]).toEqual([1, 11, 21]);

    const rootXValues = player.getChannelValues('root_position:x');
    expectArrayCloseTo(rootXValues, [0.1, 1.1, 2.1]);
  });

  it('updates channel values at arbitrary frames and preserves quaternion normalization', () => {
    const { robot } = createMockRobot();
    const clip = createClip(3);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.setChannelValue('joint:joint_c', 2, 42)).toBe(true);
    expect(player.getChannelValues('joint:joint_c')[2]).toBeCloseTo(42);

    expect(player.setChannelValue('root_position:y', 1, -3.25)).toBe(true);
    expect(player.getChannelValues('root_position:y')[1]).toBeCloseTo(-3.25);

    expect(player.setChannelValue('root_rotation:yaw', 1, Math.PI / 2)).toBe(true);
    const rootRotation = player.getRootRotation();
    const quatLength = Math.sqrt(
      rootRotation.x ** 2 +
        rootRotation.y ** 2 +
        rootRotation.z ** 2 +
        rootRotation.w ** 2,
    );
    expect(quatLength).toBeCloseTo(1, 5);

    const yawValues = player.getChannelValues('root_rotation:yaw');
    expect(yawValues[1]).toBeCloseTo(Math.PI / 2, 5);
  });

  it('sets a selected channel constant over a frame range without changing motion format', () => {
    const { robot } = createMockRobot();
    const clip = createClip(4);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);
    player.seek(2);

    const originalFrameCount = clip.frameCount;
    const originalStride = clip.stride;
    const originalSourceColumnCount = clip.sourceColumnCount;
    const originalDataLength = clip.data.length;
    const originalJointNames = [...clip.schema.jointNames];

    expect(player.setChannelConstant('joint:joint_b', 0, 1, 2)).toBe(true);
    expect(player.getFrameCount()).toBe(originalFrameCount);
    expect(player.getCurrentFrame()).toBe(2);
    expect(clip.stride).toBe(originalStride);
    expect(clip.sourceColumnCount).toBe(originalSourceColumnCount);
    expect(clip.data.length).toBe(originalDataLength);
    expect(clip.schema.jointNames).toEqual(originalJointNames);

    expectArrayCloseTo(player.getChannelValues('joint:joint_b'), [1, 0, 0, 31]);
    expectArrayCloseTo(player.getChannelValues('joint:joint_a'), [0, 10, 20, 30]);
    expectArrayCloseTo(player.getChannelValues('root_position:x'), [0.1, 1.1, 2.1, 3.1]);
  });

  it('translates root motion across every frame', () => {
    const { robot } = createMockRobot();
    const clip = createClip(2);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    player.translateRootMotion(1.5, -2, 0.25);

    const rootX = player.getChannelValues('root_position:x');
    const rootY = player.getChannelValues('root_position:y');
    const rootZ = player.getChannelValues('root_position:z');
    expectArrayCloseTo(rootX, [1.6, 2.6]);
    expectArrayCloseTo(rootY, [-1.8, -0.8]);
    expectArrayCloseTo(rootZ, [0.55, 1.55]);
  });

  it('offsets a selected channel range with blended transitions', () => {
    const { robot } = createMockRobot();
    const clip = createClip(6);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.offsetChannelRange('joint:joint_b', 2, 3, 10, 2)).toBe(true);

    const values = player.getChannelValues('joint:joint_b');
    expect(values[0]).toBeCloseTo(1 + 10 / 3, 5);
    expect(values[1]).toBeCloseTo(11 + 20 / 3, 5);
    expect(values[2]).toBeCloseTo(31, 5);
    expect(values[3]).toBeCloseTo(41, 5);
    expect(values[4]).toBeCloseTo(41 + 20 / 3, 5);
    expect(values[5]).toBeCloseTo(51 + 10 / 3, 5);
  });

  it('smooths a selected channel range while keeping the edges anchored', () => {
    const { robot } = createMockRobot();
    const clip = createClip(5);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.setChannelValue('joint:joint_a', 2, 100)).toBe(true);
    expect(player.smoothChannelRange('joint:joint_a', 0, 4, 1)).toBe(true);

    const values = player.getChannelValues('joint:joint_a');
    expect(values[0]).toBeCloseTo(0, 5);
    expect(values[1]).toBeCloseTo(30, 5);
    expect(values[2]).toBeCloseTo(60, 5);
    expect(values[3]).toBeCloseTo(50, 5);
    expect(values[4]).toBeCloseTo(40, 5);
  });

  it('emits clip edit merge keys for motion edits', () => {
    const { robot } = createMockRobot();
    const clip = createClip(3);
    const player = new G1MotionPlayer();
    const mergeKeys: string[] = [];

    player.onClipEditStarted = (mergeKey) => mergeKeys.push(mergeKey);
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.setChannelValue('joint:joint_a', 0, 7)).toBe(true);
    expect(player.setChannelConstant('joint:joint_c', 0)).toBe(true);
    player.setJointValue('joint_b', 9);
    player.translateRootMotion(0.5, 0, 0);
    player.setFrameCount(4, 'end');
    expect(player.cropFrameRange(1, 2)).toBe(true);

    expect(mergeKeys).toEqual([
      'curve:joint:joint_a',
      'channel_constant:joint:joint_c',
      'joint:joint_b',
      'translate_root_motion',
      'frame_count:end',
      'crop_range:1:2',
    ]);
  });

  it('duplicates a selected frame into the motion data stream', () => {
    const { robot } = createMockRobot();
    const clip = createClip(3);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);
    player.seek(1);

    expect(player.duplicateFrame(1, 2, 'after')).toBe(true);
    expect(player.getFrameCount()).toBe(5);
    expect(player.getCurrentFrame()).toBe(1);

    const rootX = player.getChannelValues('root_position:x');
    expect(rootX[0]).toBeCloseTo(0.1, 5);
    expect(rootX[1]).toBeCloseTo(1.1, 5);
    expect(rootX[2]).toBeCloseTo(1.1, 5);
    expect(rootX[3]).toBeCloseTo(1.1, 5);
    expect(rootX[4]).toBeCloseTo(2.1, 5);

    const jointB = player.getChannelValues('joint:joint_b');
    expect(jointB[0]).toBeCloseTo(1, 5);
    expect(jointB[1]).toBeCloseTo(11, 5);
    expect(jointB[2]).toBeCloseTo(11, 5);
    expect(jointB[3]).toBeCloseTo(11, 5);
    expect(jointB[4]).toBeCloseTo(21, 5);
  });

  it('duplicates a selected frame range into the motion data stream', () => {
    const { robot } = createMockRobot();
    const clip = createClip(5);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.duplicateFrameRange(1, 2, 2, 'after')).toBe(true);
    expect(player.getFrameCount()).toBe(9);

    const rootX = player.getChannelValues('root_position:x');
    const expectedRootX = [0.1, 1.1, 2.1, 1.1, 2.1, 1.1, 2.1, 3.1, 4.1];
    expectedRootX.forEach((value, index) => {
      expect(rootX[index]).toBeCloseTo(value, 5);
    });

    const jointC = player.getChannelValues('joint:joint_c');
    const expectedJointC = [2, 12, 22, 12, 22, 12, 22, 32, 42];
    expectedJointC.forEach((value, index) => {
      expect(jointC[index]).toBeCloseTo(value, 5);
    });
  });

  it('crops a selected frame range into a new motion data stream', () => {
    const { robot } = createMockRobot();
    const clip = createClip(5);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);
    player.seek(3);

    expect(player.cropFrameRange(1, 3)).toBe(true);
    expect(player.getFrameCount()).toBe(3);
    expect(player.getCurrentFrame()).toBe(2);

    const rootX = player.getChannelValues('root_position:x');
    [1.1, 2.1, 3.1].forEach((value, index) => {
      expect(rootX[index]).toBeCloseTo(value, 5);
    });

    const jointA = player.getChannelValues('joint:joint_a');
    [10, 20, 30].forEach((value, index) => {
      expect(jointA[index]).toBeCloseTo(value, 5);
    });

    expect(player.cropFrameRange(0, 2)).toBe(false);
  });

  it('keeps BeyondMimic source arrays aligned when frames are duplicated', () => {
    const { robot } = createMockRobot();
    const clip = createClip(3);
    clip.beyondMimicSource = {
      frameCount: 3,
      jointCount: 3,
      bodyCount: 2,
      jointVel: new Float64Array([0, 1, 2, 10, 11, 12, 20, 21, 22]),
      bodyPosW: new Float64Array([
        0, 1, 2, 3, 4, 5,
        10, 11, 12, 13, 14, 15,
        20, 21, 22, 23, 24, 25,
      ]),
      bodyQuatW: new Float64Array([
        0, 1, 2, 3, 4, 5, 6, 7,
        10, 11, 12, 13, 14, 15, 16, 17,
        20, 21, 22, 23, 24, 25, 26, 27,
      ]),
      bodyLinVelW: new Float64Array([
        0, 1, 2, 3, 4, 5,
        10, 11, 12, 13, 14, 15,
        20, 21, 22, 23, 24, 25,
      ]),
      bodyAngVelW: new Float64Array([
        100, 101, 102, 103, 104, 105,
        110, 111, 112, 113, 114, 115,
        120, 121, 122, 123, 124, 125,
      ]),
    };
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.duplicateFrame(1, 1, 'after')).toBe(true);

    const source = player.getClip()?.beyondMimicSource;
    expect(source?.frameCount).toBe(4);
    expect([...(source?.jointVel ?? [])]).toEqual([
      0, 1, 2,
      10, 11, 12,
      10, 11, 12,
      20, 21, 22,
    ]);
    expect(Array.from(source?.bodyPosW.slice(6, 18) ?? [])).toEqual([
      10, 11, 12, 13, 14, 15,
      10, 11, 12, 13, 14, 15,
    ]);
    expect(Array.from(source?.bodyQuatW.slice(8, 24) ?? [])).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17,
      10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect(Array.from(source?.bodyAngVelW.slice(6, 18) ?? [])).toEqual([
      110, 111, 112, 113, 114, 115,
      110, 111, 112, 113, 114, 115,
    ]);
  });

  it('keeps BeyondMimic source arrays aligned when frame ranges are duplicated', () => {
    const { robot } = createMockRobot();
    const clip = createClip(4);
    clip.beyondMimicSource = {
      frameCount: 4,
      jointCount: 2,
      bodyCount: 1,
      jointVel: new Float64Array([0, 1, 10, 11, 20, 21, 30, 31]),
      bodyPosW: new Float64Array([
        0, 1, 2,
        10, 11, 12,
        20, 21, 22,
        30, 31, 32,
      ]),
      bodyQuatW: new Float64Array([
        0, 1, 2, 3,
        10, 11, 12, 13,
        20, 21, 22, 23,
        30, 31, 32, 33,
      ]),
    };
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.duplicateFrameRange(1, 2, 1, 'after')).toBe(true);

    const source = player.getClip()?.beyondMimicSource;
    expect(source?.frameCount).toBe(6);
    expect([...(source?.jointVel ?? [])]).toEqual([
      0, 1,
      10, 11,
      20, 21,
      10, 11,
      20, 21,
      30, 31,
    ]);
    expect([...(source?.bodyPosW ?? [])]).toEqual([
      0, 1, 2,
      10, 11, 12,
      20, 21, 22,
      10, 11, 12,
      20, 21, 22,
      30, 31, 32,
    ]);
    expect([...(source?.bodyQuatW ?? [])]).toEqual([
      0, 1, 2, 3,
      10, 11, 12, 13,
      20, 21, 22, 23,
      10, 11, 12, 13,
      20, 21, 22, 23,
      30, 31, 32, 33,
    ]);
  });

  it('keeps BeyondMimic source arrays aligned when frame ranges are cropped', () => {
    const { robot } = createMockRobot();
    const clip = createClip(5);
    clip.beyondMimicSource = {
      frameCount: 5,
      jointCount: 2,
      bodyCount: 1,
      jointVel: new Float64Array([0, 1, 10, 11, 20, 21, 30, 31, 40, 41]),
      bodyPosW: new Float64Array([
        0, 1, 2,
        10, 11, 12,
        20, 21, 22,
        30, 31, 32,
        40, 41, 42,
      ]),
      bodyQuatW: new Float64Array([
        0, 1, 2, 3,
        10, 11, 12, 13,
        20, 21, 22, 23,
        30, 31, 32, 33,
        40, 41, 42, 43,
      ]),
      bodyLinVelW: new Float64Array([
        100, 101, 102,
        110, 111, 112,
        120, 121, 122,
        130, 131, 132,
        140, 141, 142,
      ]),
      bodyAngVelW: new Float64Array([
        200, 201, 202,
        210, 211, 212,
        220, 221, 222,
        230, 231, 232,
        240, 241, 242,
      ]),
    };
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.cropFrameRange(1, 3)).toBe(true);

    const source = player.getClip()?.beyondMimicSource;
    expect(source?.frameCount).toBe(3);
    expect([...(source?.jointVel ?? [])]).toEqual([10, 11, 20, 21, 30, 31]);
    expect([...(source?.bodyPosW ?? [])]).toEqual([
      10, 11, 12,
      20, 21, 22,
      30, 31, 32,
    ]);
    expect([...(source?.bodyQuatW ?? [])]).toEqual([
      10, 11, 12, 13,
      20, 21, 22, 23,
      30, 31, 32, 33,
    ]);
    expect([...(source?.bodyLinVelW ?? [])]).toEqual([
      110, 111, 112,
      120, 121, 122,
      130, 131, 132,
    ]);
    expect([...(source?.bodyAngVelW ?? [])]).toEqual([
      210, 211, 212,
      220, 221, 222,
      230, 231, 232,
    ]);
  });

  it('prepends zero-pose hold and blend frames before the original motion', () => {
    const { robot } = createMockRobot();
    const clip = createClip(2);
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    const report = player.prependZeroPose(2, 2);

    expect(report?.insertedFrameCount).toBe(4);
    expect(report?.maxJointDelta).toBeCloseTo(2, 5);
    expect(player.getFrameCount()).toBe(6);
    expect(player.getCurrentFrame()).toBe(4);

    const rootX = player.getChannelValues('root_position:x');
    for (let frame = 0; frame < 5; frame += 1) {
      expect(rootX[frame]).toBeCloseTo(0.1, 5);
    }

    const jointA = player.getChannelValues('joint:joint_a');
    const jointB = player.getChannelValues('joint:joint_b');
    const jointC = player.getChannelValues('joint:joint_c');
    expect(Array.from(jointA.slice(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(jointB[0]).toBeCloseTo(0, 5);
    expect(jointB[1]).toBeCloseTo(0, 5);
    expect(jointB[2]).toBeCloseTo(1 / 3, 5);
    expect(jointB[3]).toBeCloseTo(2 / 3, 5);
    expect(jointB[4]).toBeCloseTo(1, 5);
    expect(jointC[2]).toBeCloseTo(2 / 3, 5);
    expect(jointC[3]).toBeCloseTo(4 / 3, 5);
    expect(jointC[4]).toBeCloseTo(2, 5);
  });

  it('keeps BeyondMimic source arrays aligned when zero-pose frames are prepended', () => {
    const { robot } = createMockRobot();
    const clip = createClip(2);
    clip.beyondMimicSource = {
      frameCount: 2,
      jointCount: 2,
      bodyCount: 1,
      jointVel: new Float64Array([0, 1, 10, 11]),
      bodyPosW: new Float64Array([0, 1, 2, 10, 11, 12]),
      bodyQuatW: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0]),
    };
    const player = new G1MotionPlayer();
    player.attachRobot(robot);
    player.loadClip(clip);

    expect(player.prependZeroPose(1, 1)?.insertedFrameCount).toBe(2);

    const source = player.getClip()?.beyondMimicSource;
    expect(source?.frameCount).toBe(4);
    expect([...(source?.jointVel ?? [])]).toEqual([0, 1, 0, 1, 0, 1, 10, 11]);
    expect([...(source?.bodyPosW ?? [])]).toEqual([
      0, 1, 2,
      0, 1, 2,
      0, 1, 2,
      10, 11, 12,
    ]);
    expect([...(source?.bodyQuatW ?? [])]).toEqual([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
    ]);
  });

  it('clones clips for history snapshots without sharing data buffers', () => {
    const clip = createClip(2);
    const snapshot = G1MotionPlayer.cloneClip(clip);

    clip.data[0] = 999;
    clip.schema.jointNames[0] = 'modified_joint';

    expect(snapshot.data[0]).toBeCloseTo(0.1);
    expect(snapshot.schema.jointNames[0]).toBe('joint_a');
    expect(snapshot.data).not.toBe(clip.data);
    expect(snapshot.schema.jointNames).not.toBe(clip.schema.jointNames);
  });

  it('continues looping playback until paused and emits playback state transitions', () => {
    let nowMs = 0;
    let nextRafId = 1;
    let pendingCallback: unknown = null;
    const cancelSpy = vi.fn();
    const player = new G1MotionPlayer({
      now: () => nowMs,
      requestAnimationFrame: (callback: RafCallback) => {
        pendingCallback = callback;
        const id = nextRafId;
        nextRafId += 1;
        return id;
      },
      cancelAnimationFrame: cancelSpy,
    });
    const { robot } = createMockRobot();
    const clip = createClip(3);
    const playbackEvents: boolean[] = [];
    const frameIndices: number[] = [];

    player.onPlaybackStateChanged = (isPlaying) => playbackEvents.push(isPlaying);
    player.onFrameChanged = (snapshot) => frameIndices.push(snapshot.frameIndex);
    player.attachRobot(robot);
    player.loadClip(clip);
    player.play();

    expect(playbackEvents).toEqual([true]);
    expect(pendingCallback).not.toBeNull();

    const tick1 = pendingCallback;
    nowMs = 35;
    pendingCallback = null;
    if (typeof tick1 !== 'function') {
      throw new Error('Expected first RAF callback.');
    }
    (tick1 as RafCallback)(nowMs);
    expect(frameIndices).toContain(1);
    expect(playbackEvents).toEqual([true]);
    expect(pendingCallback).not.toBeNull();

    const tick2 = pendingCallback;
    nowMs = 80;
    pendingCallback = null;
    if (typeof tick2 !== 'function') {
      throw new Error('Expected second RAF callback.');
    }
    (tick2 as RafCallback)(nowMs);

    expect(frameIndices[frameIndices.length - 1]).toBe(2);
    expect(playbackEvents).toEqual([true]);
    expect(pendingCallback).not.toBeNull();

    player.pause();

    expect(playbackEvents).toEqual([true, false]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith(3);
  });
});
