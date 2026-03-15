export type ViewerState =
  | 'idle'
  | 'drag_over'
  | 'loading'
  | 'model_ready'
  | 'playing'
  | 'error';
export type ViewMode = 'free' | 'root_lock';

export type DroppedFileMap = Map<string, File>;

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
}

export interface CsvMotionLoadResult {
  clip: MotionClip;
  selectedCsvPath: string;
  warnings: string[];
}
