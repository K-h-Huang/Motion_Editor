import { Euler, Quaternion, Vector3 } from 'three';

import { DEFAULT_ROOT_COMPONENT_COUNT, DEFAULT_ROOT_JOINT_NAME } from '../io/motion/MotionSchema';
import type { MotionClip, UrdfRobotLike } from '../types/viewer';

type RequestFrameFn = (callback: FrameRequestCallback) => number;
type CancelFrameFn = (requestId: number) => void;

export interface MotionBindingReport {
  missingRequiredJoints: string[];
  missingRootJoint: boolean;
}

export interface MotionFrameSnapshot {
  frameIndex: number;
  frameCount: number;
  fps: number;
  timeSeconds: number;
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

export class G1MotionPlayer {
  public onFrameChanged: ((snapshot: MotionFrameSnapshot) => void) | null = null;
  public onPlaybackStateChanged: ((isPlaying: boolean) => void) | null = null;
  public onWarning: ((warning: string) => void) | null = null;
  public onJointAnglesChanged: ((jointNames: string[], jointValues: number[]) => void) | null = null;

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
    };
  }

  loadClip(clip: MotionClip | null): MotionBindingReport {
    this.pause();
    this.clip = clip;
    this.currentFrame = 0;
    this.bindingReport = this.rebindRobot();

    if (!this.clip) {
      return {
        missingRequiredJoints: [...this.bindingReport.missingRequiredJoints],
        missingRootJoint: this.bindingReport.missingRootJoint,
      };
    }

    this.applyFrame(0);
    return {
      missingRequiredJoints: [...this.bindingReport.missingRequiredJoints],
      missingRootJoint: this.bindingReport.missingRootJoint,
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

  setRootPosition(x: number, y: number, z: number): void {
    if (!this.clip) {
      return;
    }

    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = z;

    // 更新当前帧以反映更改
    this.applyFrame(this.currentFrame);
  }

  setRootRotation(x: number, y: number, z: number, w: number): void {
    if (!this.clip) {
      return;
    }

    const base = this.currentFrame * this.clip.stride;
    const data = this.clip.data;
    data[base + 3] = x;
    data[base + 4] = y;
    data[base + 5] = z;
    data[base + 6] = w;

    // 更新当前帧以反映更改
    this.applyFrame(this.currentFrame);
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

    const rootComponentCount = schema.rootComponentCount || DEFAULT_ROOT_COMPONENT_COUNT;
    const base = this.currentFrame * this.clip.stride;
    this.clip.data[base + rootComponentCount + jointIndex] = value;

    const setter = this.jointSetters[jointIndex];
    if (setter) {
      setter(value);
    }

    this.onJointAnglesChanged?.(this.getJointNames(), this.getCurrentJointValues());
  }

  getClip(): any {
    return this.clip;
  }

  setFrameCount(newFrameCount: number): void {
    if (!this.clip || newFrameCount < 2) {
      return;
    }

    const oldFrameCount = this.clip.frameCount;
    if (newFrameCount === oldFrameCount) {
      return;
    }

    const stride = this.clip.stride;
    const oldData = this.clip.data;
    const newData = new Float32Array(newFrameCount * stride);

    // 复制现有帧
    const framesToCopy = Math.min(oldFrameCount, newFrameCount);
    for (let i = 0; i < framesToCopy * stride; i++) {
      newData[i] = oldData[i];
    }

    // 如果新帧数更多，用最后一帧填充
    if (newFrameCount > oldFrameCount && oldFrameCount > 0) {
      const lastFrameData = oldData.slice((oldFrameCount - 1) * stride, oldFrameCount * stride);
      for (let i = oldFrameCount; i < newFrameCount; i++) {
        for (let j = 0; j < stride; j++) {
          newData[i * stride + j] = lastFrameData[j];
        }
      }
    }

    this.clip.data = newData;
    this.clip.frameCount = newFrameCount;

    // 确保当前帧在有效范围内
    this.currentFrame = Math.min(this.currentFrame, newFrameCount - 1);
    this.applyFrame(this.currentFrame);
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
      };
    }

    if (!this.robot) {
      return {
        missingRequiredJoints: [...schema.jointNames],
        missingRootJoint: true,
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
    };

    if (!report.missingRootJoint && !this.rootSetter && this.rootTransformFallback && this.clip) {
      this.onWarning?.(
        `Joint "${rootJointName}" was not found. Root motion is applied to robot transform fallback.`,
      );
    }

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

  private applyFrame(frameIndex: number): void {
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
    this.onFrameChanged?.({
      frameIndex: frame,
      frameCount: this.clip.frameCount,
      fps: this.clip.fps,
      timeSeconds: frame / Math.max(this.clip.fps, 1),
    });
    this.onJointAnglesChanged?.(this.getJointNames(), this.getCurrentJointValues());
  }
}

