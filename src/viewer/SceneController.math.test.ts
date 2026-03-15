import { describe, expect, it } from 'vitest';

import {
  computeCameraDistance,
  computeGridScale,
  getModelRootRotationX,
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
});
