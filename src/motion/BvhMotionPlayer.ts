import { AnimationMixer, LoopRepeat } from 'three';

import type { MotionFrameSnapshot } from './G1MotionPlayer';

type RequestFrameFn = (callback: FrameRequestCallback) => number;
type CancelFrameFn = (requestId: number) => void;

interface ClipTiming {
  frameCount: number;
  fps: number;
  durationSeconds: number;
}

interface BvhMotionPlayerOptions {
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

function inferTiming(clip: any): ClipTiming {
  let sampleTimes: ArrayLike<number> | null = null;

  for (const track of clip.tracks) {
    if (!track.times || track.times.length === 0) {
      continue;
    }
    if (!sampleTimes || track.times.length > sampleTimes.length) {
      sampleTimes = track.times;
    }
  }

  if (sampleTimes && sampleTimes.length > 1) {
    const rawStep = sampleTimes[1] - sampleTimes[0];
    const safeStep = Number.isFinite(rawStep) && rawStep > 1e-6 ? rawStep : 1 / 30;
    const fps = 1 / safeStep;
    const frameCount = sampleTimes.length;
    const durationSeconds = (frameCount - 1) / Math.max(fps, 1e-6);
    return {
      frameCount,
      fps,
      durationSeconds,
    };
  }

  const fallbackFps = 30;
  if (Number.isFinite(clip.duration) && clip.duration > 0) {
    const frameCount = Math.max(1, Math.round(clip.duration * fallbackFps) + 1);
    return {
      frameCount,
      fps: fallbackFps,
      durationSeconds: clip.duration,
    };
  }

  return {
    frameCount: 1,
    fps: fallbackFps,
    durationSeconds: 0,
  };
}

export class BvhMotionPlayer {
  public onFrameChanged: ((snapshot: MotionFrameSnapshot) => void) | null = null;
  public onPlaybackStateChanged: ((isPlaying: boolean) => void) | null = null;
  public onWarning: ((warning: string) => void) | null = null;

  private readonly now: () => number;
  private readonly requestFrame: RequestFrameFn;
  private readonly cancelFrame: CancelFrameFn;
  private playbackTarget: any = null;
  private mixer: any = null;
  private action: any = null;
  private clip: any = null;
  private frameCount = 0;
  private fps = 30;
  private durationSeconds = 0;
  private currentFrame = 0;
  private isPlaying = false;
  private rafId: number | null = null;
  private playbackStartTimeMs = 0;

  constructor(options: BvhMotionPlayerOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.requestFrame =
      options.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => defaultRequestFrame(callback, this.now));
    this.cancelFrame = options.cancelAnimationFrame ?? defaultCancelFrame;
  }

  load(target: any, clip: any): void {
    this.pause();
    this.disposeMixer();
    this.clip = null;
    this.frameCount = 0;
    this.currentFrame = 0;

    if (!target || !clip) {
      return;
    }

    this.playbackTarget = target;
    this.mixer = new AnimationMixer(target);
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(LoopRepeat, Infinity);
    this.action.play();

    const timing = inferTiming(clip);
    this.clip = clip;
    this.frameCount = timing.frameCount;
    this.fps = timing.fps;
    this.durationSeconds = timing.durationSeconds;
    if (this.frameCount <= 0) {
      this.onWarning?.('BVH clip has no valid frames.');
      return;
    }

    this.applyFrame(0);
  }

  play(): void {
    if (this.isPlaying || !this.clip || this.frameCount <= 1) {
      return;
    }

    const lastFrame = this.frameCount - 1;
    if (this.currentFrame >= lastFrame) {
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

  setFps(nextFps: number): void {
    if (!Number.isFinite(nextFps) || nextFps <= 0) {
      return;
    }

    this.fps = Math.max(0.1, Number(nextFps.toFixed(3)));
    if (!this.clip) {
      return;
    }

    this.applyFrame(this.currentFrame);
    if (this.isPlaying) {
      this.playbackStartTimeMs = this.now() - this.currentFrame * this.getFrameDurationMs();
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
    this.disposeMixer();
    this.playbackTarget = null;
    this.clip = null;
    this.onFrameChanged = null;
    this.onPlaybackStateChanged = null;
    this.onWarning = null;
  }

  private readonly handleAnimationFrame = (timestamp: number): void => {
    if (!this.isPlaying || !this.clip) {
      return;
    }

    const elapsedMs = timestamp - this.playbackStartTimeMs;
    const frameCount = this.frameCount;
    const nextFrame = Math.floor(elapsedMs / this.getFrameDurationMs()) % frameCount;

    if (nextFrame !== this.currentFrame) {
      this.applyFrame(nextFrame);
    }

    this.rafId = this.requestFrame(this.handleAnimationFrame);
  };

  private disposeMixer(): void {
    if (this.mixer && this.playbackTarget) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.playbackTarget);
    }
    this.mixer = null;
    this.action = null;
    this.playbackTarget = null;
  }

  private getFrameDurationMs(): number {
    return 1000 / Math.max(this.fps, 1);
  }

  private clampFrame(frameIndex: number): number {
    const lastFrame = Math.max(this.frameCount - 1, 0);
    return Math.min(lastFrame, Math.max(0, Math.floor(frameIndex)));
  }

  private applyFrame(frameIndex: number): void {
    if (!this.clip || !this.mixer) {
      return;
    }

    const frame = this.clampFrame(frameIndex);
    const frameTimeSeconds = frame / Math.max(this.fps, 1);
    const safeTime = Math.min(frameTimeSeconds, this.durationSeconds);
    this.mixer.setTime(safeTime);
    this.currentFrame = frame;
    this.onFrameChanged?.({
      frameIndex: frame,
      frameCount: this.frameCount,
      fps: this.fps,
      timeSeconds: safeTime,
    });
  }
}
