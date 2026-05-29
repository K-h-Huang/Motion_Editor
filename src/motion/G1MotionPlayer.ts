import { Euler, Quaternion, Vector3 } from 'three';

import { DEFAULT_ROOT_COMPONENT_COUNT, DEFAULT_ROOT_JOINT_NAME } from '../io/motion/MotionSchema';
import type {
  BeyondMimicMotionSource,
  MotionClip,
  MotionClipSnapshot,
  MotionCurveChannel,
  MotionCurveAxis,
  UrdfRobotLike,
} from '../types/viewer';

type RequestFrameFn = (callback: FrameRequestCallback) => number;
type CancelFrameFn = (requestId: number) => void;

export interface MotionBindingReport {
  missingRequiredJoints: string[];
  missingRootJoint: boolean;
  usesRootTransformFallback: boolean;
}

export interface MotionFrameSnapshot {
  frameIndex: number;
  frameCount: number;
  fps: number;
  timeSeconds: number;
}

export interface RestPosePrependReport {
  insertedFrameCount: number;
  holdFrames: number;
  blendFrames: number;
  maxJointDelta: number;
  averageJointDelta: number;
}

const ROOT_POSITION_AXES = ['x', 'y', 'z'] as const satisfies readonly MotionCurveAxis[];
const ROOT_ROTATION_AXES = ['roll', 'pitch', 'yaw'] as const satisfies readonly MotionCurveAxis[];

function buildRootPositionChannel(axis: typeof ROOT_POSITION_AXES[number]): MotionCurveChannel {
  return {
    id: `root_position:${axis}`,
    label: `Root Position ${axis.toUpperCase()}`,
    kind: 'root_position',
    axis,
  };
}

function buildRootRotationChannel(axis: typeof ROOT_ROTATION_AXES[number]): MotionCurveChannel {
  return {
    id: `root_rotation:${axis}`,
    label: `Root Rotation ${axis[0]?.toUpperCase()}${axis.slice(1)}`,
    kind: 'root_rotation',
    axis,
  };
}

interface G1MotionPlayerOptions {
  now?: () => number;
  requestAnimationFrame?: RequestFrameFn;
  cancelAnimationFrame?: CancelFrameFn;
}

function defaultNow(): number {
  if (typeof globalThis.performance !== 'undefined') {
    return globalThis.performance.now();
  }

  return Date.now();
}

function defaultRequestFrame(callback: FrameRequestCallback, now: () => number): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }

  return setTimeout(() => callback(now()), 16) as unknown as number;
}

function defaultCancelFrame(requestId: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(requestId);
    return;
  }

  clearTimeout(requestId as unknown as ReturnType<typeof setTimeout>);
}

function duplicateFloat64Frames(
  values: Float64Array | undefined,
  oldFrameCount: number,
  frameStride: number,
  sourceFrame: number,
  insertionFrame: number,
  duplicateCount: number,
): Float64Array | undefined {
  if (!values || oldFrameCount <= 0 || frameStride <= 0) {
    return values;
  }
  if (values.length !== oldFrameCount * frameStride) {
    return values;
  }

  const newValues = new Float64Array((oldFrameCount + duplicateCount) * frameStride);
  const copyBeforeLength = insertionFrame * frameStride;
  newValues.set(values.subarray(0, copyBeforeLength), 0);

  const sourceStart = sourceFrame * frameStride;
  const sourceFrameValues = values.subarray(sourceStart, sourceStart + frameStride);
  for (let copyIndex = 0; copyIndex < duplicateCount; copyIndex += 1) {
    newValues.set(sourceFrameValues, (insertionFrame + copyIndex) * frameStride);
  }

  newValues.set(
    values.subarray(copyBeforeLength),
    (insertionFrame + duplicateCount) * frameStride,
  );
  return newValues;
}

function duplicateFloat64FrameRange(
  values: Float64Array | undefined,
  oldFrameCount: number,
  frameStride: number,
  startFrame: number,
  endFrame: number,
  insertionFrame: number,
  copyCount: number,
): Float64Array | undefined {
  if (!values || oldFrameCount <= 0 || frameStride <= 0) {
    return values;
  }
  if (values.length !== oldFrameCount * frameStride) {
    return values;
  }

  const rangeFrameCount = Math.max(0, endFrame - startFrame + 1);
  const insertedFrameCount = rangeFrameCount * copyCount;
  if (rangeFrameCount <= 0 || insertedFrameCount <= 0) {
    return values;
  }

  const newValues = new Float64Array((oldFrameCount + insertedFrameCount) * frameStride);
  const copyBeforeLength = insertionFrame * frameStride;
  const rangeValues = values.subarray(startFrame * frameStride, (endFrame + 1) * frameStride);
  newValues.set(values.subarray(0, copyBeforeLength), 0);
  for (let copyIndex = 0; copyIndex < copyCount; copyIndex += 1) {
    newValues.set(rangeValues, (insertionFrame + copyIndex * rangeFrameCount) * frameStride);
  }
  newValues.set(
    values.subarray(copyBeforeLength),
    (insertionFrame + insertedFrameCount) * frameStride,
  );
  return newValues;
}

function cropFloat64FrameRange(
  values: Float64Array | undefined,
  oldFrameCount: number,
  frameStride: number,
  startFrame: number,
  endFrame: number,
): Float64Array | undefined {
  if (!values || oldFrameCount <= 0 || frameStride <= 0) {
    return values;
  }
  if (values.length !== oldFrameCount * frameStride) {
    return values;
  }

  const rangeFrameCount = Math.max(0, endFrame - startFrame + 1);
  if (rangeFrameCount <= 0) {
    return values;
  }

  const newValues = new Float64Array(rangeFrameCount * frameStride);
  newValues.set(values.subarray(startFrame * frameStride, (endFrame + 1) * frameStride));
  return newValues;
}

function resizeFloat64Frames(
  values: Float64Array | undefined,
  oldFrameCount: number,
  newFrameCount: number,
  frameStride: number,
  sourceFrame: number,
  insertPosition: 'start' | 'end',
): Float64Array | undefined {
  if (!values || oldFrameCount <= 0 || newFrameCount <= 0 || frameStride <= 0) {
    return values;
  }
  if (values.length !== oldFrameCount * frameStride) {
    return values;
  }

  const newValues = new Float64Array(newFrameCount * frameStride);
  if (newFrameCount <= oldFrameCount) {
    newValues.set(values.subarray(0, newFrameCount * frameStride), 0);
    return newValues;
  }

  const insertedFrameCount = newFrameCount - oldFrameCount;
  const sourceStart = sourceFrame * frameStride;
  const sourceFrameValues = values.subarray(sourceStart, sourceStart + frameStride);

  if (insertPosition === 'start') {
    for (let copyIndex = 0; copyIndex < insertedFrameCount; copyIndex += 1) {
      newValues.set(sourceFrameValues, copyIndex * frameStride);
    }
    newValues.set(values, insertedFrameCount * frameStride);
    return newValues;
  }

  newValues.set(values, 0);
  for (let copyIndex = oldFrameCount; copyIndex < newFrameCount; copyIndex += 1) {
    newValues.set(sourceFrameValues, copyIndex * frameStride);
  }
  return newValues;
}

function duplicateBeyondMimicSourceFrame(
  source: BeyondMimicMotionSource | undefined,
  oldFrameCount: number,
  sourceFrame: number,
  insertionFrame: number,
  duplicateCount: number,
): BeyondMimicMotionSource | undefined {
  if (!source || source.frameCount !== oldFrameCount || duplicateCount <= 0) {
    return source;
  }

  const bodyPosStride = source.bodyCount * 3;
  const bodyQuatStride = source.bodyCount * 4;
  return {
    ...source,
    frameCount: oldFrameCount + duplicateCount,
    jointVel: duplicateFloat64Frames(
      source.jointVel,
      oldFrameCount,
      source.jointCount,
      sourceFrame,
      insertionFrame,
      duplicateCount,
    ),
    bodyPosW: duplicateFloat64Frames(
      source.bodyPosW,
      oldFrameCount,
      bodyPosStride,
      sourceFrame,
      insertionFrame,
      duplicateCount,
    ) ?? source.bodyPosW,
    bodyQuatW: duplicateFloat64Frames(
      source.bodyQuatW,
      oldFrameCount,
      bodyQuatStride,
      sourceFrame,
      insertionFrame,
      duplicateCount,
    ) ?? source.bodyQuatW,
    bodyLinVelW: duplicateFloat64Frames(
      source.bodyLinVelW,
      oldFrameCount,
      bodyPosStride,
      sourceFrame,
      insertionFrame,
      duplicateCount,
    ),
    bodyAngVelW: duplicateFloat64Frames(
      source.bodyAngVelW,
      oldFrameCount,
      bodyPosStride,
      sourceFrame,
      insertionFrame,
      duplicateCount,
    ),
  };
}

function duplicateBeyondMimicSourceFrameRange(
  source: BeyondMimicMotionSource | undefined,
  oldFrameCount: number,
  startFrame: number,
  endFrame: number,
  insertionFrame: number,
  copyCount: number,
): BeyondMimicMotionSource | undefined {
  if (!source || source.frameCount !== oldFrameCount || copyCount <= 0) {
    return source;
  }

  const rangeFrameCount = Math.max(0, endFrame - startFrame + 1);
  const insertedFrameCount = rangeFrameCount * copyCount;
  if (insertedFrameCount <= 0) {
    return source;
  }

  const bodyPosStride = source.bodyCount * 3;
  const bodyQuatStride = source.bodyCount * 4;
  return {
    ...source,
    frameCount: oldFrameCount + insertedFrameCount,
    jointVel: duplicateFloat64FrameRange(
      source.jointVel,
      oldFrameCount,
      source.jointCount,
      startFrame,
      endFrame,
      insertionFrame,
      copyCount,
    ),
    bodyPosW: duplicateFloat64FrameRange(
      source.bodyPosW,
      oldFrameCount,
      bodyPosStride,
      startFrame,
      endFrame,
      insertionFrame,
      copyCount,
    ) ?? source.bodyPosW,
    bodyQuatW: duplicateFloat64FrameRange(
      source.bodyQuatW,
      oldFrameCount,
      bodyQuatStride,
      startFrame,
      endFrame,
      insertionFrame,
      copyCount,
    ) ?? source.bodyQuatW,
    bodyLinVelW: duplicateFloat64FrameRange(
      source.bodyLinVelW,
      oldFrameCount,
      bodyPosStride,
      startFrame,
      endFrame,
      insertionFrame,
      copyCount,
    ),
    bodyAngVelW: duplicateFloat64FrameRange(
      source.bodyAngVelW,
      oldFrameCount,
      bodyPosStride,
      startFrame,
      endFrame,
      insertionFrame,
      copyCount,
    ),
  };
}

function cropBeyondMimicSourceFrameRange(
  source: BeyondMimicMotionSource | undefined,
  oldFrameCount: number,
  startFrame: number,
  endFrame: number,
): BeyondMimicMotionSource | undefined {
  if (!source || source.frameCount !== oldFrameCount) {
    return source;
  }

  const rangeFrameCount = Math.max(0, endFrame - startFrame + 1);
  if (rangeFrameCount <= 0) {
    return source;
  }

  const bodyPosStride = source.bodyCount * 3;
  const bodyQuatStride = source.bodyCount * 4;
  return {
    ...source,
    frameCount: rangeFrameCount,
    jointVel: cropFloat64FrameRange(
      source.jointVel,
      oldFrameCount,
      source.jointCount,
      startFrame,
      endFrame,
    ),
    bodyPosW: cropFloat64FrameRange(
      source.bodyPosW,
      oldFrameCount,
      bodyPosStride,
      startFrame,
      endFrame,
    ) ?? source.bodyPosW,
    bodyQuatW: cropFloat64FrameRange(
      source.bodyQuatW,
      oldFrameCount,
      bodyQuatStride,
      startFrame,
      endFrame,
    ) ?? source.bodyQuatW,
    bodyLinVelW: cropFloat64FrameRange(
      source.bodyLinVelW,
      oldFrameCount,
      bodyPosStride,
      startFrame,
      endFrame,
    ),
    bodyAngVelW: cropFloat64FrameRange(
      source.bodyAngVelW,
      oldFrameCount,
      bodyPosStride,
      startFrame,
      endFrame,
    ),
  };
}

function prependBeyondMimicSourceFrames(
  source: BeyondMimicMotionSource | undefined,
  oldFrameCount: number,
  insertedFrameCount: number,
): BeyondMimicMotionSource | undefined {
  if (!source || source.frameCount !== oldFrameCount || insertedFrameCount <= 0) {
    return source;
  }

  const bodyPosStride = source.bodyCount * 3;
  const bodyQuatStride = source.bodyCount * 4;
  return {
    ...source,
    frameCount: oldFrameCount + insertedFrameCount,
    jointVel: duplicateFloat64Frames(
      source.jointVel,
      oldFrameCount,
      source.jointCount,
      0,
      0,
      insertedFrameCount,
    ),
    bodyPosW: duplicateFloat64Frames(
      source.bodyPosW,
      oldFrameCount,
      bodyPosStride,
      0,
      0,
      insertedFrameCount,
    ) ?? source.bodyPosW,
    bodyQuatW: duplicateFloat64Frames(
      source.bodyQuatW,
      oldFrameCount,
      bodyQuatStride,
      0,
      0,
      insertedFrameCount,
    ) ?? source.bodyQuatW,
    bodyLinVelW: duplicateFloat64Frames(
      source.bodyLinVelW,
      oldFrameCount,
      bodyPosStride,
      0,
      0,
      insertedFrameCount,
    ),
    bodyAngVelW: duplicateFloat64Frames(
      source.bodyAngVelW,
      oldFrameCount,
      bodyPosStride,
      0,
      0,
      insertedFrameCount,
    ),
  };
}

function resizeBeyondMimicSourceFrames(
  source: BeyondMimicMotionSource | undefined,
  oldFrameCount: number,
  newFrameCount: number,
  insertPosition: 'start' | 'end',
): BeyondMimicMotionSource | undefined {
  if (!source || source.frameCount !== oldFrameCount) {
    return source;
  }

  const sourceFrame = insertPosition === 'start' ? 0 : Math.max(0, oldFrameCount - 1);
  const bodyPosStride = source.bodyCount * 3;
  const bodyQuatStride = source.bodyCount * 4;
  return {
    ...source,
    frameCount: newFrameCount,
    jointVel: resizeFloat64Frames(
      source.jointVel,
      oldFrameCount,
      newFrameCount,
      source.jointCount,
      sourceFrame,
      insertPosition,
    ),
    bodyPosW: resizeFloat64Frames(
      source.bodyPosW,
      oldFrameCount,
      newFrameCount,
      bodyPosStride,
      sourceFrame,
      insertPosition,
    ) ?? source.bodyPosW,
    bodyQuatW: resizeFloat64Frames(
      source.bodyQuatW,
      oldFrameCount,
      newFrameCount,
      bodyQuatStride,
      sourceFrame,
      insertPosition,
    ) ?? source.bodyQuatW,
    bodyLinVelW: resizeFloat64Frames(
      source.bodyLinVelW,
      oldFrameCount,
      newFrameCount,
      bodyPosStride,
      sourceFrame,
      insertPosition,
    ),
    bodyAngVelW: resizeFloat64Frames(
      source.bodyAngVelW,
      oldFrameCount,
      newFrameCount,
      bodyPosStride,
      sourceFrame,
      insertPosition,
    ),
  };
}

export class G1MotionPlayer {
  public onFrameChanged: ((snapshot: MotionFrameSnapshot) => void) | null = null;
  public onPlaybackStateChanged: ((isPlaying: boolean) => void) | null = null;
  public onWarning: ((warning: string) => void) | null = null;
  public onJointAnglesChanged: ((jointNames: string[], jointValues: number[]) => void) | null = null;
  public onClipDataChanged: ((frameIndex: number) => void) | null = null;
  public onClipEditStarted: ((mergeKey: string) => void) | null = null;

  private readonly now: () => number;
  private readonly requestFrame: RequestFrameFn;
  private readonly cancelFrame: CancelFrameFn;
  private readonly tempQuat = new Quaternion();
  private readonly tempEuler = new Euler();
  private robot: UrdfRobotLike | null = null;
  private clip: MotionClip | null = null;
  private rootSetter: ((x: number, y: number, z: number, roll: number, pitch: number, yaw: number) => void) | null =
    null;
  private rootTransformAnchor:
    | {
        basePosition: any;
        baseQuaternion: any;
      }
    | null = null;
  private rootTransformFallback:
    | {
        position: { copy: (value: any) => unknown };
        quaternion: { copy: (value: any) => unknown };
        basePosition: any;
        baseQuaternion: any;
      }
    | null = null;
  private jointSetters: Array<((value: number) => void) | null> = [];
  private bindingReport: MotionBindingReport = {
    missingRequiredJoints: [],
    missingRootJoint: false,
    usesRootTransformFallback: false,
  };
  private currentFrame = 0;
  private isPlaying = false;
  private rafId: number | null = null;
  private playbackStartTimeMs = 0;
  private readonly tempMotionPosition = new Vector3();
  private readonly tempComposedPosition = new Vector3();
  private readonly tempComposedQuaternion = new Quaternion();

  constructor(options: G1MotionPlayerOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.requestFrame =
      options.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => defaultRequestFrame(callback, this.now));
    this.cancelFrame = options.cancelAnimationFrame ?? defaultCancelFrame;
  }

  attachRobot(robot: UrdfRobotLike | null): MotionBindingReport {
    const robotChanged = this.robot !== robot;
    this.robot = robot;
    if (!robot) {
      this.rootTransformAnchor = null;
    } else if (robotChanged) {
      this.rootTransformAnchor = this.captureRootTransformAnchor(robot);
    }

    this.bindingReport = this.rebindRobot();
    if (this.clip && this.bindingReport.missingRequiredJoints.length === 0) {
      this.applyFrame(this.currentFrame);
    }

    return {
      missingRequiredJoints: [...this.bindingReport.missingRequiredJoints],
      missingRootJoint: this.bindingReport.missingRootJoint,
      usesRootTransformFallback: this.bindingReport.usesRootTransformFallback,
    };
  }

  loadClip(clip: MotionClip | null, initialFrame = 0): MotionBindingReport {
    this.pause();
    this.clip = clip;
    this.currentFrame = 0;
    if (clip) {
      this.resetBoundRobotRootTransform();
    }
    this.bindingReport = this.rebindRobot();

    if (!this.clip) {
      return {
        missingRequiredJoints: [...this.bindingReport.missingRequiredJoints],
        missingRootJoint: this.bindingReport.missingRootJoint,
        usesRootTransformFallback: this.bindingReport.usesRootTransformFallback,
      };
    }

    this.applyFrame(this.clampFrame(initialFrame));
    return {
      missingRequiredJoints: [...this.bindingReport.missingRequiredJoints],
      missingRootJoint: this.bindingReport.missingRootJoint,
      usesRootTransformFallback: this.bindingReport.usesRootTransformFallback,
    };
  }

  play(): void {
    if (this.isPlaying || !this.clip) {
      return;
    }

    const lastFrame = this.clip.frameCount - 1;
    if (lastFrame <= 0 || this.currentFrame >= lastFrame) {
      return;
    }

    this.isPlaying = true;
    this.playbackStartTimeMs = this.now() - this.currentFrame * this.getFrameDurationMs();
    this.onPlaybackStateChanged?.(true);
    this.rafId = this.requestFrame(this.handleAnimationFrame);
  }

  pause(): void {
    if (this.rafId !== null) {
      this.cancelFrame(this.rafId);
      this.rafId = null;
    }

    if (!this.isPlaying) {
      return;
    }

    this.isPlaying = false;
    this.onPlaybackStateChanged?.(false);
  }

  seek(frameIndex: number): void {
    if (!this.clip) {
      return;
    }

    const targetFrame = this.clampFrame(frameIndex);
    this.applyFrame(targetFrame);

    if (this.isPlaying) {
      this.playbackStartTimeMs = this.now() - targetFrame * this.getFrameDurationMs();
    }
  }

  withFrameAppliedSilently<T>(frameIndex: number, callback: () => T): T | null {
    if (!this.clip) {
      return null;
    }

    const originalFrame = this.currentFrame;
    const targetFrame = this.clampFrame(frameIndex);
    this.applyFrame(targetFrame, false);
    try {
      return callback();
    } finally {
      this.applyFrame(originalFrame, false);
    }
  }

  reset(): void {
    this.pause();
    if (!this.clip) {
      this.currentFrame = 0;
      return;
    }

    this.applyFrame(0);
  }

  dispose(): void {
    this.pause();
    this.robot = null;
    this.clip = null;
    this.rootSetter = null;
    this.jointSetters = [];
    this.onFrameChanged = null;
    this.onPlaybackStateChanged = null;
    this.onWarning = null;
    this.onJointAnglesChanged = null;
    this.onClipDataChanged = null;
    this.onClipEditStarted = null;
  }

  getJointNames(): string[] {
    if (!this.clip) {
      return [];
    }
    return [...this.clip.schema.jointNames];
  }

  getCurrentJointValues(): number[] {
    if (!this.clip) {
      return [];
    }

    const schema = this.clip.schema;
    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    const jointValues: number[] = [];

    for (let jointIndex = 0; jointIndex < this.jointSetters.length; jointIndex += 1) {
      jointValues.push(data[base + rootComponentCount + jointIndex]);
    }

    return jointValues;
  }

  getRootPosition(): { x: number; y: number; z: number } {
    if (!this.clip) {
      return { x: 0, y: 0, z: 0 };
    }

    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    return {
      x: data[base],
      y: data[base + 1],
      z: data[base + 2]
    };
  }

  getRootRotation(): { x: number; y: number; z: number; w: number } {
    if (!this.clip) {
      return { x: 0, y: 0, z: 0, w: 1 };
    }

    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    return {
      x: data[base + 3],
      y: data[base + 4],
      z: data[base + 5],
      w: data[base + 6]
    };
  }

  getCurveChannels(): MotionCurveChannel[] {
    if (!this.clip) {
      return [];
    }

    return [
      ...ROOT_POSITION_AXES.map(buildRootPositionChannel),
      ...ROOT_ROTATION_AXES.map(buildRootRotationChannel),
      ...this.clip.schema.jointNames.map((jointName) => ({
        id: `joint:${jointName}`,
        label: jointName,
        kind: 'joint' as const,
        jointName,
      })),
    ];
  }

  getCurveChannelById(channelId: string): MotionCurveChannel | null {
    return this.getCurveChannels().find((channel) => channel.id === channelId) ?? null;
  }

  getChannelValues(channelId: string): Float32Array {
    if (!this.clip) {
      return new Float32Array();
    }

    const channel = this.getCurveChannelById(channelId);
    if (!channel) {
      return new Float32Array();
    }

    if (channel.kind === 'root_position' && channel.axis) {
      return this.getRootPositionChannelValues(channel.axis);
    }

    if (channel.kind === 'root_rotation' && channel.axis) {
      return this.getRootRotationChannelValues(channel.axis);
    }

    if (channel.kind === 'joint' && channel.jointName) {
      return this.getJointChannelValues(channel.jointName);
    }

    return new Float32Array();
  }

  setChannelValue(channelId: string, frameIndex: number, value: number): boolean {
    if (!this.clip) {
      return false;
    }

    const channel = this.getCurveChannelById(channelId);
    if (!channel) {
      return false;
    }

    this.beginClipEdit(`curve:${channelId}`);
    const frame = this.clampFrame(frameIndex);
    const didWrite = this.writeChannelValue(channel, frame, value);
    if (!didWrite) {
      return false;
    }

    this.commitClipEdit(frame);
    return true;
  }

  setChannelConstant(
    channelId: string,
    value: number,
    startFrame = 0,
    endFrame = this.clip ? this.clip.frameCount - 1 : 0,
  ): boolean {
    if (!this.clip || !Number.isFinite(value)) {
      return false;
    }

    const channel = this.getCurveChannelById(channelId);
    if (!channel) {
      return false;
    }

    const { start, end } = this.normalizeFrameRange(startFrame, endFrame);
    this.beginClipEdit(`channel_constant:${channelId}`);
    let didWrite = false;
    for (let frame = start; frame <= end; frame += 1) {
      didWrite = this.writeChannelValue(channel, frame, value) || didWrite;
    }

    if (!didWrite) {
      return false;
    }

    this.commitClipEdit(this.currentFrame, start, end);
    return true;
  }

  offsetChannelRange(
    channelId: string,
    startFrame: number,
    endFrame: number,
    delta: number,
    blendFrames = 0,
  ): boolean {
    if (!this.clip) {
      return false;
    }

    const channel = this.getCurveChannelById(channelId);
    if (!channel || !Number.isFinite(delta)) {
      return false;
    }

    const { start, end } = this.normalizeFrameRange(startFrame, endFrame);
    const transitionFrames = Math.max(0, Math.floor(blendFrames));
    const sourceValues = this.getChannelValues(channelId);
    if (sourceValues.length !== this.clip.frameCount) {
      return false;
    }

    this.beginClipEdit(`range_offset:${channelId}`);
    const affectedStart = Math.max(0, start - transitionFrames);
    const affectedEnd = Math.min(this.clip.frameCount - 1, end + transitionFrames);
    let didChange = false;

    for (let frame = affectedStart; frame <= affectedEnd; frame += 1) {
      const weight = this.getRangeBlendWeight(frame, start, end, transitionFrames);
      if (weight <= 0) {
        continue;
      }

      const nextValue = sourceValues[frame] + delta * weight;
      didChange = this.writeChannelValue(channel, frame, nextValue) || didChange;
    }

    if (didChange) {
      this.commitClipEdit(this.currentFrame, affectedStart, affectedEnd);
    }

    return didChange;
  }

  smoothChannelRange(channelId: string, startFrame: number, endFrame: number, passes = 1): boolean {
    if (!this.clip) {
      return false;
    }

    const channel = this.getCurveChannelById(channelId);
    if (!channel) {
      return false;
    }

    const { start, end } = this.normalizeFrameRange(startFrame, endFrame);
    if (end - start < 2) {
      return false;
    }

    const iterationCount = Math.max(1, Math.min(12, Math.floor(passes)));
    let working = this.getChannelValues(channelId);
    if (working.length !== this.clip.frameCount) {
      return false;
    }

    this.beginClipEdit(`range_smooth:${channelId}`);
    for (let iteration = 0; iteration < iterationCount; iteration += 1) {
      const nextValues = new Float32Array(working);
      for (let frame = start + 1; frame < end; frame += 1) {
        nextValues[frame] =
          (working[frame - 1] + working[frame] * 2 + working[frame + 1]) / 4;
      }
      working = nextValues;
    }

    let didChange = false;
    for (let frame = start + 1; frame < end; frame += 1) {
      didChange = this.writeChannelValue(channel, frame, working[frame]) || didChange;
    }

    if (didChange) {
      this.commitClipEdit(this.currentFrame, start, end);
    }

    return didChange;
  }

  setRootPosition(x: number, y: number, z: number): void {
    if (!this.clip) {
      return;
    }

    this.beginClipEdit('root_position');
    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = z;

    // 更新当前帧以反映更改
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
  }

  setRootRotation(x: number, y: number, z: number, w: number): void {
    if (!this.clip) {
      return;
    }

    this.beginClipEdit('root_rotation');
    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    data[base + 3] = x;
    data[base + 4] = y;
    data[base + 5] = z;
    data[base + 6] = w;

    // 更新当前帧以反映更改
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
  }

  setJointValue(jointName: string, value: number): void {
    if (!this.clip) {
      return;
    }

    const schema = this.clip.schema;
    const jointIndex = schema.jointNames.indexOf(jointName);
    if (jointIndex === -1) {
      return;
    }

    this.beginClipEdit(`joint:${jointName}`);
    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const base = this.currentFrame * this.clip.stride;
    this.clip.data[base + rootComponentCount + jointIndex] = value;

    const setter = this.jointSetters[jointIndex];
    if (setter) {
      setter(value);
    }

    this.onJointAnglesChanged?.(this.getJointNames(), this.getCurrentJointValues());
    this.onClipDataChanged?.(this.currentFrame);
  }

  setJointValueAtFrame(jointName: string, frameIndex: number, value: number): boolean {
    if (!this.clip) {
      return false;
    }

    const jointIndex = this.clip.schema.jointNames.indexOf(jointName);
    if (jointIndex === -1) {
      return false;
    }

    this.beginClipEdit(`joint:${jointName}`);
    const didWrite = this.writeJointValueAtFrame(jointName, frameIndex, value);
    if (!didWrite) {
      return false;
    }
    this.commitClipEdit(frameIndex);
    return true;
  }

  getClip(): any {
    return this.clip;
  }

  duplicateFrame(
    frameIndex: number,
    duplicateCount: number,
    insertPosition: 'before' | 'after' = 'after',
  ): boolean {
    if (!this.clip || this.clip.frameCount <= 0) {
      return false;
    }

    const count = Math.max(0, Math.floor(duplicateCount));
    if (count <= 0) {
      return false;
    }

    const oldFrameCount = this.clip.frameCount;
    const sourceFrame = this.clampFrame(frameIndex);
    const insertionFrame =
      insertPosition === 'before' ? sourceFrame : Math.min(oldFrameCount, sourceFrame + 1);
    const newFrameCount = oldFrameCount + count;
    const stride = this.clip.stride;
    const oldData = this.clip.data;
    const newData = new Float32Array(newFrameCount * stride);
    const copyBeforeLength = insertionFrame * stride;
    const sourceFrameData = oldData.subarray(sourceFrame * stride, sourceFrame * stride + stride);

    this.beginClipEdit(`duplicate_frame:${insertPosition}`);
    newData.set(oldData.subarray(0, copyBeforeLength), 0);
    for (let copyIndex = 0; copyIndex < count; copyIndex += 1) {
      newData.set(sourceFrameData, (insertionFrame + copyIndex) * stride);
    }
    newData.set(oldData.subarray(copyBeforeLength), (insertionFrame + count) * stride);

    this.clip.data = newData;
    this.clip.frameCount = newFrameCount;
    this.clip.beyondMimicSource = duplicateBeyondMimicSourceFrame(
      this.clip.beyondMimicSource,
      oldFrameCount,
      sourceFrame,
      insertionFrame,
      count,
    );

    if (this.currentFrame >= insertionFrame) {
      this.currentFrame += count;
    }
    this.currentFrame = Math.max(0, Math.min(newFrameCount - 1, this.currentFrame));
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
    return true;
  }

  duplicateFrameRange(
    startFrame: number,
    endFrame: number,
    copyCount: number,
    insertPosition: 'before' | 'after' = 'after',
  ): boolean {
    if (!this.clip || this.clip.frameCount <= 0) {
      return false;
    }

    const count = Math.max(0, Math.floor(copyCount));
    if (count <= 0) {
      return false;
    }

    const oldFrameCount = this.clip.frameCount;
    const normalizedStart = Math.max(
      0,
      Math.min(oldFrameCount - 1, Math.floor(Math.min(startFrame, endFrame))),
    );
    const normalizedEnd = Math.max(
      normalizedStart,
      Math.min(oldFrameCount - 1, Math.floor(Math.max(startFrame, endFrame))),
    );
    const rangeFrameCount = normalizedEnd - normalizedStart + 1;
    const insertedFrameCount = rangeFrameCount * count;
    const insertionFrame =
      insertPosition === 'before' ? normalizedStart : Math.min(oldFrameCount, normalizedEnd + 1);
    const newFrameCount = oldFrameCount + insertedFrameCount;
    const stride = this.clip.stride;
    const oldData = this.clip.data;
    const newData = new Float32Array(newFrameCount * stride);
    const copyBeforeLength = insertionFrame * stride;
    const rangeData = oldData.subarray(
      normalizedStart * stride,
      (normalizedEnd + 1) * stride,
    );

    this.beginClipEdit(`duplicate_range:${insertPosition}`);
    newData.set(oldData.subarray(0, copyBeforeLength), 0);
    for (let copyIndex = 0; copyIndex < count; copyIndex += 1) {
      newData.set(rangeData, (insertionFrame + copyIndex * rangeFrameCount) * stride);
    }
    newData.set(oldData.subarray(copyBeforeLength), (insertionFrame + insertedFrameCount) * stride);

    this.clip.data = newData;
    this.clip.frameCount = newFrameCount;
    this.clip.beyondMimicSource = duplicateBeyondMimicSourceFrameRange(
      this.clip.beyondMimicSource,
      oldFrameCount,
      normalizedStart,
      normalizedEnd,
      insertionFrame,
      count,
    );

    if (this.currentFrame >= insertionFrame) {
      this.currentFrame += insertedFrameCount;
    }
    this.currentFrame = Math.max(0, Math.min(newFrameCount - 1, this.currentFrame));
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
    return true;
  }

  cropFrameRange(startFrame: number, endFrame: number): boolean {
    if (!this.clip || this.clip.frameCount <= 0) {
      return false;
    }

    const oldFrameCount = this.clip.frameCount;
    const normalizedStart = Math.max(
      0,
      Math.min(oldFrameCount - 1, Math.floor(Math.min(startFrame, endFrame))),
    );
    const normalizedEnd = Math.max(
      normalizedStart,
      Math.min(oldFrameCount - 1, Math.floor(Math.max(startFrame, endFrame))),
    );
    const rangeFrameCount = normalizedEnd - normalizedStart + 1;
    if (
      rangeFrameCount <= 0 ||
      (normalizedStart === 0 && normalizedEnd === oldFrameCount - 1)
    ) {
      return false;
    }

    const stride = this.clip.stride;
    const oldData = this.clip.data;
    const newData = new Float32Array(rangeFrameCount * stride);
    newData.set(oldData.subarray(normalizedStart * stride, (normalizedEnd + 1) * stride));

    this.beginClipEdit(`crop_range:${normalizedStart}:${normalizedEnd}`);
    this.clip.data = newData;
    this.clip.frameCount = rangeFrameCount;
    this.clip.beyondMimicSource = cropBeyondMimicSourceFrameRange(
      this.clip.beyondMimicSource,
      oldFrameCount,
      normalizedStart,
      normalizedEnd,
    );

    if (this.currentFrame < normalizedStart) {
      this.currentFrame = 0;
    } else if (this.currentFrame > normalizedEnd) {
      this.currentFrame = rangeFrameCount - 1;
    } else {
      this.currentFrame -= normalizedStart;
    }
    this.currentFrame = Math.max(0, Math.min(rangeFrameCount - 1, this.currentFrame));
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
    return true;
  }

  prependZeroPose(holdFrames: number, blendFrames: number): RestPosePrependReport | null {
    if (!this.clip || this.clip.frameCount <= 0) {
      return null;
    }

    const holdCount = Math.max(0, Math.floor(holdFrames));
    const blendCount = Math.max(0, Math.floor(blendFrames));
    const insertedFrameCount = holdCount + blendCount;
    if (insertedFrameCount <= 0) {
      return null;
    }

    const oldFrameCount = this.clip.frameCount;
    const stride = this.clip.stride;
    const rootComponentCount = this.clip.schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const jointCount = this.clip.schema.jointNames.length;
    const oldData = this.clip.data;
    const firstFrame = oldData.subarray(0, stride);
    const restFrame = new Float32Array(firstFrame);
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      restFrame[rootComponentCount + jointIndex] = 0;
    }

    let maxJointDelta = 0;
    let totalJointDelta = 0;
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      const delta = Math.abs(firstFrame[rootComponentCount + jointIndex] ?? 0);
      maxJointDelta = Math.max(maxJointDelta, delta);
      totalJointDelta += delta;
    }

    this.beginClipEdit('prepend_zero_pose');
    const newData = new Float32Array((oldFrameCount + insertedFrameCount) * stride);
    for (let frameIndex = 0; frameIndex < holdCount; frameIndex += 1) {
      newData.set(restFrame, frameIndex * stride);
    }

    for (let blendIndex = 0; blendIndex < blendCount; blendIndex += 1) {
      const targetBase = (holdCount + blendIndex) * stride;
      const t = (blendIndex + 1) / (blendCount + 1);
      for (let componentIndex = 0; componentIndex < stride; componentIndex += 1) {
        const restValue = restFrame[componentIndex] ?? 0;
        const targetValue = firstFrame[componentIndex] ?? 0;
        newData[targetBase + componentIndex] = restValue + (targetValue - restValue) * t;
      }
    }

    newData.set(oldData, insertedFrameCount * stride);
    this.clip.data = newData;
    this.clip.frameCount = oldFrameCount + insertedFrameCount;
    this.clip.beyondMimicSource = prependBeyondMimicSourceFrames(
      this.clip.beyondMimicSource,
      oldFrameCount,
      insertedFrameCount,
    );

    this.currentFrame += insertedFrameCount;
    this.currentFrame = Math.max(0, Math.min(this.clip.frameCount - 1, this.currentFrame));
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);

    return {
      insertedFrameCount,
      holdFrames: holdCount,
      blendFrames: blendCount,
      maxJointDelta,
      averageJointDelta: jointCount > 0 ? totalJointDelta / jointCount : 0,
    };
  }

  setFrameCount(newFrameCount: number, insertPosition: 'start' | 'end' = 'end'): void {
    if (!this.clip || newFrameCount < 2) {
      return;
    }

    const oldFrameCount = this.clip.frameCount;
    if (newFrameCount === oldFrameCount) {
      return;
    }

    this.beginClipEdit(`frame_count:${insertPosition}`);
    const stride = this.clip.stride;
    const oldData = this.clip.data;
    const newData = new Float32Array(newFrameCount * stride);

    if (newFrameCount > oldFrameCount && oldFrameCount > 0) {
      if (insertPosition === 'end') {
        // 在末尾插入：复制现有帧，用最后一帧填充剩余部分
        for (let i = 0; i < oldFrameCount * stride; i++) {
          newData[i] = oldData[i];
        }
        
        const lastFrameData = oldData.slice((oldFrameCount - 1) * stride, oldFrameCount * stride);
        for (let i = oldFrameCount; i < newFrameCount; i++) {
          for (let j = 0; j < stride; j++) {
            newData[i * stride + j] = lastFrameData[j];
          }
        }
      } else {
        // 在开头插入：用第一帧填充开头，然后复制现有帧
        const firstFrameData = oldData.slice(0, stride);
        for (let i = 0; i < newFrameCount - oldFrameCount; i++) {
          for (let j = 0; j < stride; j++) {
            newData[i * stride + j] = firstFrameData[j];
          }
        }
        
        for (let i = 0; i < oldFrameCount * stride; i++) {
          newData[(newFrameCount - oldFrameCount) * stride + i] = oldData[i];
        }
        
        // 调整当前帧位置
        this.currentFrame += (newFrameCount - oldFrameCount);
      }
    } else {
      // 减少帧数：只复制需要的帧
      const framesToCopy = Math.min(oldFrameCount, newFrameCount);
      for (let i = 0; i < framesToCopy * stride; i++) {
        newData[i] = oldData[i];
      }
    }

    this.clip.data = newData;
    this.clip.frameCount = newFrameCount;
    this.clip.beyondMimicSource = resizeBeyondMimicSourceFrames(
      this.clip.beyondMimicSource,
      oldFrameCount,
      newFrameCount,
      insertPosition,
    );

    // 确保当前帧在有效范围内
    this.currentFrame = Math.min(this.currentFrame, newFrameCount - 1);
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
  }

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  getFrameCount(): number {
    if (!this.clip) {
      return 0;
    }
    return this.clip.frameCount;
  }

  smoothJoint(jointName: string, currentFrame: number, framesBefore: number, framesAfter: number, keyframes?: number[]): void {
    if (!this.clip) {
      return;
    }

    const schema = this.clip.schema;
    const jointIndex = schema.jointNames.indexOf(jointName);
    if (jointIndex === -1) {
      return;
    }

    this.beginClipEdit(`smooth_joint:${jointName}`);
    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const stride = this.clip.stride;
    const data = this.clip.data;
    const frameCount = this.clip.frameCount;

    // Find adjacent keyframes
    let prevKeyframe = -1;
    let nextKeyframe = -1;
    
    if (keyframes && keyframes.length > 0) {
      const sortedKeyframes = [...keyframes].sort((a, b) => a - b);
      for (let i = 0; i < sortedKeyframes.length; i++) {
        if (sortedKeyframes[i] < currentFrame) {
          prevKeyframe = sortedKeyframes[i];
        } else if (sortedKeyframes[i] > currentFrame) {
          nextKeyframe = sortedKeyframes[i];
          break;
        } else {
          // Current frame is a keyframe, use adjacent keyframes as interval
          if (i > 0) {
            prevKeyframe = sortedKeyframes[i - 1];
          }
          if (i < sortedKeyframes.length - 1) {
            nextKeyframe = sortedKeyframes[i + 1];
          }
          break;
        }
      }
    }

    // Calculate user-specified range
    const userStart = Math.max(0, currentFrame - framesBefore);
    const userEnd = Math.min(frameCount - 1, currentFrame + framesAfter);
    
    // Calculate keyframe range
    const keyframeStart = prevKeyframe !== -1 ? prevKeyframe : userStart;
    const keyframeEnd = nextKeyframe !== -1 ? nextKeyframe : userEnd;
    
    // Determine smoothing range: use the smallest interval
    const startFrame = Math.max(userStart, keyframeStart);
    const endFrame = Math.min(userEnd, keyframeEnd);

    // Save the current frame value that user modified
    const currentFrameBase = currentFrame * stride;
    const savedValue = data[currentFrameBase + rootComponentCount + jointIndex];

    // Get values at start and end frames
    const startBase = startFrame * stride;
    const endBase = endFrame * stride;
    const startValue = data[startBase + rootComponentCount + jointIndex];
    const endValue = data[endBase + rootComponentCount + jointIndex];

    // Linear interpolation between start and current frame
    for (let frame = startFrame; frame < currentFrame; frame++) {
      const t = (frame - startFrame) / (currentFrame - startFrame);
      const interpolatedValue = startValue + (savedValue - startValue) * t;
      const frameBase = frame * stride;
      data[frameBase + rootComponentCount + jointIndex] = interpolatedValue;
    }

    // Linear interpolation between current and end frame
    for (let frame = currentFrame + 1; frame <= endFrame; frame++) {
      const t = (frame - currentFrame) / (endFrame - currentFrame);
      const interpolatedValue = savedValue + (endValue - savedValue) * t;
      const frameBase = frame * stride;
      data[frameBase + rootComponentCount + jointIndex] = interpolatedValue;
    }

    // Restore the saved value for the current frame
    data[currentFrameBase + rootComponentCount + jointIndex] = savedValue;

    // Update current frame to reflect changes
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
  }

  interpolateBetweenKeyframes(keyframeList?: number[]): void {
    if (!this.clip) {
      return;
    }

    const schema = this.clip.schema;
    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const stride = this.clip.stride;
    const data = this.clip.data;
    const frameCount = this.clip.frameCount;
    const jointCount = schema.jointNames.length;

    let keyframes: number[];
    if (keyframeList && keyframeList.length >= 2) {
      // 使用传入的关键帧列表
      keyframes = [...keyframeList].sort((a, b) => a - b);
      console.log('Using provided keyframes:', keyframes);
    } else {
      // 自动检测关键帧作为备用
      keyframes = [];
      for (let frame = 0; frame < frameCount; frame++) {
        const base = frame * stride;
        let isKeyframe = false;
        
        // 检查root位置
        if (data[base] !== 0 || data[base + 1] !== 0 || data[base + 2] !== 0) {
          isKeyframe = true;
        }
        
        // 检查root旋转（不是单位四元数）
        if (data[base + 3] !== 0 || data[base + 4] !== 0 || data[base + 5] !== 0 || data[base + 6] !== 1) {
          isKeyframe = true;
        }
        
        // 检查关节角度
        for (let jointIndex = 0; jointIndex < jointCount; jointIndex++) {
          if (data[base + rootComponentCount + jointIndex] !== 0) {
            isKeyframe = true;
            break;
          }
        }
        
        if (isKeyframe) {
          keyframes.push(frame);
        }
      }
      console.log('Auto-detected keyframes:', keyframes);
    }

    // 如果关键帧少于2个，无法进行插值
    if (keyframes.length < 2) {
      console.log('Not enough keyframes for interpolation:', keyframes.length);
      return;
    }

    this.beginClipEdit('interpolate_keyframes');
    console.log('Starting interpolation between keyframes:', keyframes);

    // 在关键帧之间进行线性插值
    for (let i = 0; i < keyframes.length - 1; i++) {
      const startFrame = keyframes[i];
      const endFrame = keyframes[i + 1];
      
      if (endFrame - startFrame <= 1) {
        console.log('Skipping interpolation between adjacent keyframes:', startFrame, 'and', endFrame);
        continue; // 相邻关键帧不需要插值
      }

      console.log('Interpolating between keyframes:', startFrame, 'and', endFrame);

      // 对每个帧进行插值
      for (let frame = startFrame + 1; frame < endFrame; frame++) {
        const t = (frame - startFrame) / (endFrame - startFrame);
        const startBase = startFrame * stride;
        const endBase = endFrame * stride;
        const frameBase = frame * stride;

        // 插值root位置
        for (let j = 0; j < 3; j++) {
          data[frameBase + j] = data[startBase + j] + (data[endBase + j] - data[startBase + j]) * t;
        }

        // 插值root旋转（四元数插值）
        Quaternion.slerpVectors(
          this.tempQuat,
          new Quaternion(data[startBase + 3], data[startBase + 4], data[startBase + 5], data[startBase + 6]),
          new Quaternion(data[endBase + 3], data[endBase + 4], data[endBase + 5], data[endBase + 6]),
          t
        );
        data[frameBase + 3] = this.tempQuat.x;
        data[frameBase + 4] = this.tempQuat.y;
        data[frameBase + 5] = this.tempQuat.z;
        data[frameBase + 6] = this.tempQuat.w;

        // 插值关节角度
        for (let jointIndex = 0; jointIndex < jointCount; jointIndex++) {
          const startValue = data[startBase + rootComponentCount + jointIndex];
          const endValue = data[endBase + rootComponentCount + jointIndex];
          data[frameBase + rootComponentCount + jointIndex] = startValue + (endValue - startValue) * t;
        }
      }
    }

    console.log('Interpolation completed');

    // 更新当前帧以反映更改
    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
  }

  translateRootMotion(deltaX: number, deltaY: number, deltaZ: number): void {
    if (!this.clip) {
      return;
    }

    this.beginClipEdit('translate_root_motion');
    for (let frame = 0; frame < this.clip.frameCount; frame += 1) {
      const base = frame * this.clip.stride;
      this.clip.data[base] += deltaX;
      this.clip.data[base + 1] += deltaY;
      this.clip.data[base + 2] += deltaZ;
    }

    this.applyFrame(this.currentFrame);
    this.onClipDataChanged?.(this.currentFrame);
  }

  private normalizeFrameRange(startFrame: number, endFrame: number): { start: number; end: number } {
    const start = this.clampFrame(Math.min(startFrame, endFrame));
    const end = this.clampFrame(Math.max(startFrame, endFrame));
    return { start, end };
  }

  private getRangeBlendWeight(
    frame: number,
    startFrame: number,
    endFrame: number,
    blendFrames: number,
  ): number {
    if (frame >= startFrame && frame <= endFrame) {
      return 1;
    }

    if (blendFrames <= 0) {
      return 0;
    }

    if (frame < startFrame && frame >= startFrame - blendFrames) {
      return 1 - (startFrame - frame) / (blendFrames + 1);
    }

    if (frame > endFrame && frame <= endFrame + blendFrames) {
      return 1 - (frame - endFrame) / (blendFrames + 1);
    }

    return 0;
  }

  private commitClipEdit(frameIndex: number, affectedStartFrame = frameIndex, affectedEndFrame = frameIndex): void {
    if (this.currentFrame >= affectedStartFrame && this.currentFrame <= affectedEndFrame) {
      this.applyFrame(this.currentFrame);
    }
    this.onClipDataChanged?.(frameIndex);
  }

  private beginClipEdit(mergeKey: string): void {
    if (!this.clip) {
      return;
    }
    this.onClipEditStarted?.(mergeKey);
  }

  static cloneClip(clip: MotionClip): MotionClipSnapshot {
    return {
      name: clip.name,
      sourcePath: clip.sourcePath,
      fps: clip.fps,
      frameCount: clip.frameCount,
      stride: clip.stride,
      schema: {
        rootJointName: clip.schema.rootJointName,
        rootComponentCount: clip.schema.rootComponentCount,
        jointNames: [...clip.schema.jointNames],
      },
      csvMode: clip.csvMode,
      sourceColumnCount: clip.sourceColumnCount,
      data: new Float32Array(clip.data),
      beyondMimicSource: clip.beyondMimicSource,
    };
  }

  private writeChannelValue(channel: MotionCurveChannel, frameIndex: number, value: number): boolean {
    if (channel.kind === 'root_position' && channel.axis) {
      return this.writeRootPositionAxisValue(frameIndex, channel.axis, value);
    }

    if (channel.kind === 'root_rotation' && channel.axis) {
      return this.writeRootRotationAxisValue(frameIndex, channel.axis, value);
    }

    if (channel.kind === 'joint' && channel.jointName) {
      return this.writeJointValueAtFrame(channel.jointName, frameIndex, value);
    }

    return false;
  }

  private getRootPositionChannelValues(axis: MotionCurveAxis): Float32Array {
    if (!this.clip) {
      return new Float32Array();
    }

    const offset = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const values = new Float32Array(this.clip.frameCount);
    for (let frame = 0; frame < this.clip.frameCount; frame += 1) {
      values[frame] = this.clip.data[frame * this.clip.stride + offset];
    }
    return values;
  }

  private getRootRotationChannelValues(axis: MotionCurveAxis): Float32Array {
    if (!this.clip) {
      return new Float32Array();
    }

    const axisIndex = axis === 'roll' ? 0 : axis === 'pitch' ? 1 : 2;
    const values = new Float32Array(this.clip.frameCount);
    let previousValue = 0;

    for (let frame = 0; frame < this.clip.frameCount; frame += 1) {
      const base = frame * this.clip.stride;
      this.tempQuat.set(
        this.clip.data[base + 3],
        this.clip.data[base + 4],
        this.clip.data[base + 5],
        this.clip.data[base + 6],
      );
      if (this.tempQuat.lengthSq() < 1e-10) {
        this.tempQuat.identity();
      } else {
        this.tempQuat.normalize();
      }

      this.tempEuler.setFromQuaternion(this.tempQuat, 'XYZ');
      const rawValue =
        axisIndex === 0 ? this.tempEuler.x : axisIndex === 1 ? this.tempEuler.y : this.tempEuler.z;
      values[frame] = frame === 0 ? rawValue : this.unwrapAngle(rawValue, previousValue);
      previousValue = values[frame];
    }

    return values;
  }

  private getJointChannelValues(jointName: string): Float32Array {
    if (!this.clip) {
      return new Float32Array();
    }

    const jointIndex = this.clip.schema.jointNames.indexOf(jointName);
    if (jointIndex === -1) {
      return new Float32Array();
    }

    const rootComponentCount = this.clip.schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const values = new Float32Array(this.clip.frameCount);
    for (let frame = 0; frame < this.clip.frameCount; frame += 1) {
      values[frame] = this.clip.data[frame * this.clip.stride + rootComponentCount + jointIndex];
    }
    return values;
  }

  private writeRootPositionAxisValue(frameIndex: number, axis: MotionCurveAxis, value: number): boolean {
    if (!this.clip) {
      return false;
    }

    const offset = axis === 'x' ? 0 : axis === 'y' ? 1 : axis === 'z' ? 2 : -1;
    if (offset < 0) {
      return false;
    }

    const frame = this.clampFrame(frameIndex);
    const base = frame * this.clip.stride;
    this.clip.data[base + offset] = value;
    return true;
  }

  private writeRootRotationAxisValue(frameIndex: number, axis: MotionCurveAxis, value: number): boolean {
    if (!this.clip) {
      return false;
    }

    const frame = this.clampFrame(frameIndex);
    const base = frame * this.clip.stride;
    this.tempQuat.set(
      this.clip.data[base + 3],
      this.clip.data[base + 4],
      this.clip.data[base + 5],
      this.clip.data[base + 6],
    );
    if (this.tempQuat.lengthSq() < 1e-10) {
      this.tempQuat.identity();
    } else {
      this.tempQuat.normalize();
    }

    this.tempEuler.setFromQuaternion(this.tempQuat, 'XYZ');
    if (axis === 'roll') {
      this.tempEuler.x = value;
    } else if (axis === 'pitch') {
      this.tempEuler.y = value;
    } else if (axis === 'yaw') {
      this.tempEuler.z = value;
    } else {
      return false;
    }

    this.tempQuat.setFromEuler(this.tempEuler);
    this.clip.data[base + 3] = this.tempQuat.x;
    this.clip.data[base + 4] = this.tempQuat.y;
    this.clip.data[base + 5] = this.tempQuat.z;
    this.clip.data[base + 6] = this.tempQuat.w;
    return true;
  }

  private writeJointValueAtFrame(jointName: string, frameIndex: number, value: number): boolean {
    if (!this.clip) {
      return false;
    }

    const schema = this.clip.schema;
    const jointIndex = schema.jointNames.indexOf(jointName);
    if (jointIndex === -1) {
      return false;
    }

    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const frame = this.clampFrame(frameIndex);
    const base = frame * this.clip.stride;
    this.clip.data[base + rootComponentCount + jointIndex] = value;
    return true;
  }

  private unwrapAngle(value: number, previousValue: number): number {
    let unwrapped = value;
    const twoPi = Math.PI * 2;

    while (unwrapped - previousValue > Math.PI) {
      unwrapped -= twoPi;
    }
    while (unwrapped - previousValue < -Math.PI) {
      unwrapped += twoPi;
    }

    return unwrapped;
  }

  private readonly handleAnimationFrame = (timestamp: number): void => {
    if (!this.isPlaying || !this.clip) {
      return;
    }

    const elapsedMs = timestamp - this.playbackStartTimeMs;
    const frameCount = this.clip.frameCount;
    const nextFrame = Math.floor(elapsedMs / this.getFrameDurationMs()) % frameCount;

    if (nextFrame !== this.currentFrame) {
      this.applyFrame(nextFrame);
    }

    this.rafId = this.requestFrame(this.handleAnimationFrame);
  };

  private getFrameDurationMs(): number {
    const fps = this.clip?.fps ?? 30;
    return 1000 / Math.max(fps, 1);
  }

  private clampFrame(frameIndex: number): number {
    if (!this.clip) {
      return 0;
    }

    const lastFrame = Math.max(this.clip.frameCount - 1, 0);
    return Math.min(lastFrame, Math.max(0, Math.floor(frameIndex)));
  }

  private rebindRobot(): MotionBindingReport {
    this.rootSetter = null;
    this.rootTransformFallback = null;
    this.jointSetters = [];

    const schema = this.clip?.schema ?? null;
    if (!schema) {
      return {
        missingRequiredJoints: [],
        missingRootJoint: false,
        usesRootTransformFallback: false,
      };
    }

    if (!this.robot) {
      return {
        missingRequiredJoints: [...schema.jointNames],
        missingRootJoint: true,
        usesRootTransformFallback: false,
      };
    }

    const missingRequired: string[] = [];
    for (const jointName of schema.jointNames) {
      const setter = this.createJointSetter(jointName);
      if (!setter) {
        missingRequired.push(jointName);
      }

      this.jointSetters.push(setter);
    }

    const rootJointName = schema.rootJointName || DEFAULT_ROOT_JOINT_NAME;
    this.rootSetter = this.createRootSetter(rootJointName);
    if (!this.rootSetter) {
      this.rootTransformFallback = this.createRootTransformFallback();
    }

    const report: MotionBindingReport = {
      missingRequiredJoints: missingRequired,
      missingRootJoint: !this.rootSetter && !this.rootTransformFallback,
      usesRootTransformFallback: !this.rootSetter && Boolean(this.rootTransformFallback),
    };

    if (report.missingRootJoint && this.clip) {
      this.onWarning?.(
        `Joint "${rootJointName}" was not found. Root translation/rotation is ignored.`,
      );
    }

    return report;
  }

  private createJointSetter(jointName: string): ((value: number) => void) | null {
    if (!this.robot) {
      return null;
    }

    const joint = this.robot.joints?.[jointName];
    if (this.robot.joints && !joint) {
      return null;
    }

    if (typeof this.robot.setJointValue === 'function') {
      return (value: number) => {
        this.robot?.setJointValue?.(jointName, value);
      };
    }

    if (!joint || typeof joint.setJointValue !== 'function') {
      return null;
    }

    return (value: number) => {
      joint.setJointValue?.(value);
    };
  }

  private createRootSetter(
    rootJointName: string,
  ): ((x: number, y: number, z: number, roll: number, pitch: number, yaw: number) => void) | null {
    if (!this.robot) {
      return null;
    }

    const rootJoint = this.robot.joints?.[rootJointName];
    if (this.robot.joints && !rootJoint) {
      return null;
    }

    if (typeof this.robot.setJointValue === 'function') {
      return (x, y, z, roll, pitch, yaw) => {
        this.robot?.setJointValue?.(rootJointName, x, y, z, roll, pitch, yaw);
      };
    }

    if (!rootJoint || typeof rootJoint.setJointValue !== 'function') {
      return null;
    }

    return (x, y, z, roll, pitch, yaw) => {
      rootJoint.setJointValue?.(x, y, z, roll, pitch, yaw);
    };
  }

  private captureRootTransformAnchor(robot: UrdfRobotLike): {
    basePosition: any;
    baseQuaternion: any;
  } | null {
    const target = robot as unknown as {
      position?: { clone?: () => any };
      quaternion?: { clone?: () => any };
    };

    if (
      !target.position ||
      !target.quaternion ||
      typeof target.position.clone !== 'function' ||
      typeof target.quaternion.clone !== 'function'
    ) {
      return null;
    }

    return {
      basePosition: target.position.clone(),
      baseQuaternion: target.quaternion.clone(),
    };
  }

  private createRootTransformFallback():
    | {
        position: { copy: (value: any) => unknown };
        quaternion: { copy: (value: any) => unknown };
        basePosition: any;
        baseQuaternion: any;
      }
    | null {
    if (!this.robot) {
      return null;
    }

    const target = this.robot as unknown as {
      position?: { clone?: () => any; copy?: (value: any) => unknown };
      quaternion?: { clone?: () => any; copy?: (value: any) => unknown };
      matrixWorldNeedsUpdate?: boolean;
    };

    if (
      !target.position ||
      !target.quaternion ||
      typeof target.position.clone !== 'function' ||
      typeof target.position.copy !== 'function' ||
      typeof target.quaternion.clone !== 'function' ||
      typeof target.quaternion.copy !== 'function'
    ) {
      return null;
    }

    const anchor = this.rootTransformAnchor;
    if (!anchor) {
      return null;
    }

    const position = target.position as { clone: () => any; copy: (value: any) => unknown };
    const quaternion = target.quaternion as { clone: () => any; copy: (value: any) => unknown };

    return {
      position,
      quaternion,
      basePosition: anchor.basePosition,
      baseQuaternion: anchor.baseQuaternion,
    };
  }

  private resetBoundRobotRootTransform(): void {
    const anchor = this.rootTransformAnchor;
    const target = this.robot as
      | ({
          position?: { copy?: (value: any) => unknown };
          quaternion?: { copy?: (value: any) => unknown };
          updateMatrixWorld?: (force?: boolean) => unknown;
          matrixWorldNeedsUpdate?: boolean;
        } | null);
    if (
      !anchor ||
      !target?.position ||
      !target?.quaternion ||
      typeof target.position.copy !== 'function' ||
      typeof target.quaternion.copy !== 'function'
    ) {
      return;
    }

    target.position.copy(anchor.basePosition);
    target.quaternion.copy(anchor.baseQuaternion);
    target.matrixWorldNeedsUpdate = true;
    target.updateMatrixWorld?.(true);
  }

  private applyFrame(frameIndex: number, notify = true): void {
    if (!this.clip) {
      return;
    }

    const schema = this.clip.schema;
    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const frame = this.clampFrame(frameIndex);
    const base = frame * this.clip.stride;
    const data = this.clip.data;

    if (this.rootSetter) {
      const x = data[base];
      const y = data[base + 1];
      const z = data[base + 2];
      const qx = data[base + 3];
      const qy = data[base + 4];
      const qz = data[base + 5];
      const qw = data[base + 6];

      this.tempQuat.set(qx, qy, qz, qw);
      if (this.tempQuat.lengthSq() < 1e-10) {
        this.tempQuat.identity();
      } else {
        this.tempQuat.normalize();
      }

      this.tempEuler.setFromQuaternion(this.tempQuat, 'XYZ');
      this.rootSetter(
        x,
        y,
        z,
        this.tempEuler.x,
        this.tempEuler.y,
        this.tempEuler.z,
      );
    } else if (this.rootTransformFallback) {
      const x = data[base];
      const y = data[base + 1];
      const z = data[base + 2];
      const qx = data[base + 3];
      const qy = data[base + 4];
      const qz = data[base + 5];
      const qw = data[base + 6];
      const fallback = this.rootTransformFallback;

      this.tempQuat.set(qx, qy, qz, qw);
      if (this.tempQuat.lengthSq() < 1e-10) {
        this.tempQuat.identity();
      } else {
        this.tempQuat.normalize();
      }

      this.tempMotionPosition.set(x, y, z);
      this.tempComposedPosition
        .copy(fallback.basePosition)
        .applyQuaternion(this.tempQuat)
        .add(this.tempMotionPosition);
      this.tempComposedQuaternion
        .copy(this.tempQuat)
        .multiply(fallback.baseQuaternion);

      fallback.position.copy(this.tempComposedPosition);
      fallback.quaternion.copy(this.tempComposedQuaternion);
    }

    for (let jointIndex = 0; jointIndex < this.jointSetters.length; jointIndex += 1) {
      const setter = this.jointSetters[jointIndex];
      if (!setter) {
        continue;
      }

      setter(data[base + rootComponentCount + jointIndex]);
    }

    this.currentFrame = frame;
    if (notify) {
      this.onFrameChanged?.({
        frameIndex: frame,
        frameCount: this.clip.frameCount,
        fps: this.clip.fps,
        timeSeconds: frame / Math.max(this.clip.fps, 1),
      });
      this.onJointAnglesChanged?.(this.getJointNames(), this.getCurrentJointValues());
    }
  }
}
