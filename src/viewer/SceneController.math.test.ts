import { describe, expect, it } from 'vitest';

import {
  computeGroundPlaneY,
  computeCameraDistance,
  computeGridScale,
  getModelRootRotationX,
  resolveGroundPlaneY,
} from './SceneController';

describe('SceneController math helpers', () => {
  it('computes deterministic camera distance from model size and fov', () => {
    const distance = computeCameraDistance(2.0, 55);
    expect(distance).toBeCloseTo(3.46, 2);

    const largerModelDistance = computeCameraDistance(6.0, 55);
    expect(largerModelDistance).toBeGreaterThan(distance);
  });

  it('computes bounded grid scale from model size', () => {
    expect(computeGridScale(1.0)).toBeCloseTo(1.5, 5);
    expect(computeGridScale(6.0)).toBeCloseTo(1.5, 5);
    expect(computeGridScale(80.0)).toBeCloseTo(12.8, 1);
  });

  it('maps +Z model up-axis to Y-up scene rotation', () => {
    expect(getModelRootRotationX('+Z')).toBeCloseTo(-Math.PI / 2, 6);
    expect(getModelRootRotationX('+Y')).toBe(0);
  });

  it('keeps ground at zero when grounded bounds match the configured offset', () => {
    expect(computeGroundPlaneY(0, 0)).toBeCloseTo(0, 6);
    expect(computeGroundPlaneY(1.12, 0)).toBeCloseTo(1.12, 6);
  });

  it('preserves anchored ground height while the robot root is edited upward', () => {
    expect(resolveGroundPlaneY(1.12, 0, 0)).toBe(0);
    expect(resolveGroundPlaneY(1.12, 0, 0.25)).toBe(0.25);
    expect(resolveGroundPlaneY(1.12, 0, null)).toBeCloseTo(1.12, 6);
  });

  it('supports a world-origin floor when callers anchor the ground explicitly', () => {
    const forcedGroundY = 0;
    expect(forcedGroundY).toBe(0);
    expect(resolveGroundPlaneY(0.918, 0, forcedGroundY)).toBe(0);
    expect(resolveGroundPlaneY(0.589, 0, forcedGroundY)).toBe(0);
  });
});
