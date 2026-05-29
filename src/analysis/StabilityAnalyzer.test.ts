import { Object3D, Vector2 } from 'three';
import { describe, expect, it } from 'vitest';

import type { UrdfRobotLike } from '../types/viewer';
import {
  buildStabilityFrameRanges,
  computeConvexHull2D,
  isPointInsideConvexPolygon,
  StabilityAnalyzer,
  type StabilityEvaluation,
} from './StabilityAnalyzer';

function xmlElement(name: string, attributes: Record<string, string> = {}, children: any[] = []): Element {
  return {
    localName: name,
    tagName: name,
    children,
    getAttribute: (attributeName: string) => attributes[attributeName] ?? null,
  } as unknown as Element;
}

function inertialNode(mass: number, xyz: string): Element {
  return xmlElement('link', {}, [
    xmlElement('inertial', {}, [
      xmlElement('origin', { xyz }),
      xmlElement('mass', { value: String(mass) }),
    ]),
  ]);
}

function createLink(name: string, mass: number, position: [number, number, number]): any {
  const link = new Object3D() as any;
  link.name = name;
  link.urdfName = name;
  link.urdfNode = inertialNode(mass, '0 0 0');
  link.position.set(position[0], position[1], position[2]);
  return link;
}

function createRobot(links: Record<string, any>): UrdfRobotLike {
  const robot = new Object3D() as any;
  robot.name = 'test_robot';
  robot.links = links;
  for (const link of Object.values(links)) {
    robot.add(link);
  }
  return robot as UrdfRobotLike;
}

describe('StabilityAnalyzer geometry helpers', () => {
  it('builds a convex hull and detects points inside it', () => {
    const hull = computeConvexHull2D([
      new Vector2(0, 0),
      new Vector2(1, 0),
      new Vector2(1, 1),
      new Vector2(0, 1),
      new Vector2(0.5, 0.5),
    ]);

    expect(hull).toHaveLength(4);
    expect(isPointInsideConvexPolygon(new Vector2(0.5, 0.5), hull)).toBe(true);
    expect(isPointInsideConvexPolygon(new Vector2(1.5, 0.5), hull)).toBe(false);
  });

  it('groups adjacent frame evaluations by stability state', () => {
    const ranges = buildStabilityFrameRanges([
      { frameIndex: 0, isStable: true, state: 'inside' },
      { frameIndex: 1, isStable: true, state: 'inside' },
      { frameIndex: 2, isStable: false, state: 'outside' },
      { frameIndex: 3, isStable: false, state: 'outside' },
      { frameIndex: 4, isStable: true, state: 'inside' },
    ] as StabilityEvaluation[]);

    expect(ranges).toEqual([
      { startFrame: 0, endFrame: 1, isStable: true, state: 'inside' },
      { startFrame: 2, endFrame: 3, isStable: false, state: 'outside' },
      { startFrame: 4, endFrame: 4, isStable: true, state: 'inside' },
    ]);
  });
});

describe('StabilityAnalyzer', () => {
  it('computes COM and evaluates it against foot support', () => {
    const robot = createRobot({
      torso_link: createLink('torso_link', 10, [0, 1, 0]),
      left_foot: createLink('left_foot', 1, [-0.1, 0, 0]),
      right_foot: createLink('right_foot', 1, [0.1, 0, 0]),
    });
    const analyzer = new StabilityAnalyzer(robot);

    const stable = analyzer.evaluateCurrentFrame(0, 0);
    expect(stable.isStable).toBe(true);
    expect(stable.centerOfMass?.x).toBeCloseTo(0, 5);
    expect(stable.supportPolygon).toHaveLength(4);

    (robot.links as Record<string, any>)['torso_link'].position.x = 1;
    (robot as any).updateMatrixWorld(true);
    const unstable = analyzer.evaluateCurrentFrame(1, 0);
    expect(unstable.isStable).toBe(false);
    expect(unstable.state).toBe('outside');
  });
});
