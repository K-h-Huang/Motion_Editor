export type ViewerState =
  | 'idle'
  | 'drag_over'
  | 'loading'
  | 'model_ready'
  | 'playing'
  | 'error';
export type ViewMode = 'free' | 'root_lock';
export type MotionCurveChannelKind = 'root_position' | 'root_rotation' | 'joint';
export type MotionCurveAxis = 'x' | 'y' | 'z' | 'roll' | 'pitch' | 'yaw';

export type DroppedFileMap = Map<string, File>;

export interface MotionCurveChannel {
  id: string;
  label: string;
  kind: MotionCurveChannelKind;
  axis?: MotionCurveAxis;
  jointName?: string;
}

export interface UrdfJointLike {
  jointType?: string;
  jointValue?: number[];
  setJointValue?: (...values: (number | null)[]) => boolean;
}

export interface UrdfRobotLike {
  name: string;
  joints?: Record<string, UrdfJointLike>;
  links?: Record<string, unknown>;
  setJointValue?: (jointName: string, ...values: number[]) => boolean;
  traverse: (callback: (child: unknown) => void) => void;
}

export interface LoadResult {
  robotName: string;
  linkCount: number;
  jointCount: number;
  selectedUrdfPath: string;
  motionSchema: MotionSchema;
  warnings: string[];
}

export interface LoadedRobotResult extends LoadResult {
  robot: UrdfRobotLike;
}

export interface MotionSchema {
  rootJointName: string;
  rootComponentCount: number;
  jointNames: string[];
}

export type MotionCsvMode = 'header' | 'ordered';

export interface BeyondMimicMotionSource {
  frameCount: number;
  jointCount: number;
  bodyCount: number;
  jointVel?: Float64Array;
  bodyPosW: Float64Array;
  bodyQuatW: Float64Array;
  bodyLinVelW?: Float64Array;
  bodyAngVelW?: Float64Array;
}

export interface MotionClip {
  name: string;
  sourcePath: string;
  fps: number;
  frameCount: number;
  stride: number;
  schema: MotionSchema;
  csvMode: MotionCsvMode;
  sourceColumnCount: number;
  data: Float32Array;
  beyondMimicSource?: BeyondMimicMotionSource;
}

export interface MotionClipSnapshot {
  name: string;
  sourcePath: string;
  fps: number;
  frameCount: number;
  stride: number;
  schema: MotionSchema;
  csvMode: MotionCsvMode;
  sourceColumnCount: number;
  data: Float32Array;
  beyondMimicSource?: BeyondMimicMotionSource;
}

export interface CsvMotionLoadResult {
  clip: MotionClip;
  selectedCsvPath: string;
  warnings: string[];
}
