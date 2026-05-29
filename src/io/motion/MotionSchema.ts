export const DEFAULT_MOTION_FPS = 30;
export const DEFAULT_ROOT_JOINT_NAME = 'floating_base_joint';
export const DEFAULT_ROOT_COMPONENT_COUNT = 7; // XYZ + QX/QY/QZ/QW

export const G1_BEYOND_MIMIC_JOINT_ORDER = [
  'left_hip_pitch_joint',
  'left_hip_roll_joint',
  'left_hip_yaw_joint',
  'left_knee_joint',
  'left_ankle_pitch_joint',
  'left_ankle_roll_joint',
  'right_hip_pitch_joint',
  'right_hip_roll_joint',
  'right_hip_yaw_joint',
  'right_knee_joint',
  'right_ankle_pitch_joint',
  'right_ankle_roll_joint',
  'waist_yaw_joint',
  'waist_roll_joint',
  'waist_pitch_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_roll_joint',
  'left_wrist_pitch_joint',
  'left_wrist_yaw_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_roll_joint',
  'right_wrist_pitch_joint',
  'right_wrist_yaw_joint',
] as const;

export const H1_BEYOND_MIMIC_JOINT_ORDER = [
  'left_hip_yaw_joint',
  'left_hip_roll_joint',
  'left_hip_pitch_joint',
  'left_knee_joint',
  'left_ankle_joint',
  'right_hip_yaw_joint',
  'right_hip_roll_joint',
  'right_hip_pitch_joint',
  'right_knee_joint',
  'right_ankle_joint',
  'torso_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
] as const;

export const H1_2_BEYOND_MIMIC_JOINT_ORDER = [
  'left_hip_yaw_joint',
  'left_hip_pitch_joint',
  'left_hip_roll_joint',
  'left_knee_joint',
  'left_ankle_pitch_joint',
  'left_ankle_roll_joint',
  'right_hip_yaw_joint',
  'right_hip_pitch_joint',
  'right_hip_roll_joint',
  'right_knee_joint',
  'right_ankle_pitch_joint',
  'right_ankle_roll_joint',
  'torso_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_roll_joint',
  'left_wrist_pitch_joint',
  'left_wrist_yaw_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_roll_joint',
  'right_wrist_pitch_joint',
  'right_wrist_yaw_joint',
] as const;

export function hasSameJointSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftSet = new Set(left);
  if (leftSet.size !== left.length) {
    return false;
  }

  return right.every((jointName) => leftSet.has(jointName));
}

export function normalizeJointOrderForGmr(jointNames: readonly string[]): string[] {
  return [...jointNames];
}
