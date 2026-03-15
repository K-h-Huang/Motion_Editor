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
    expect(
      warnings.some((warning) => warning.includes('Root motion is applied to robot transform fallback')),
    ).toBe(true);
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

  it('stops at the last frame and emits playback state transitions', () => {
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
    expect(playbackEvents).toEqual([true, false]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(pendingCallback).toBeNull();
  });
});

