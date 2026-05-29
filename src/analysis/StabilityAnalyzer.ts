import { Box3, Vector2, Vector3 } from 'three';

import type { UrdfRobotLike } from '../types/viewer';

type ThreeVector2 = InstanceType<typeof Vector2>;
type ThreeVector3 = InstanceType<typeof Vector3>;

const DEFAULT_CONTACT_HEIGHT_THRESHOLD = 0.04;
const DEFAULT_FOOT_HALF_LENGTH = 0.08;
const DEFAULT_FOOT_HALF_WIDTH = 0.045;
const POLYGON_EPSILON = 1e-6;

interface MassLinkSample {
  link: any;
  linkName: string;
  mass: number;
  localCenterOfMass: ThreeVector3;
}

interface SupportLinkSample {
  link: any;
  linkName: string;
}

export type StabilityState = 'inside' | 'outside' | 'no_support' | 'no_mass';

export interface StabilityEvaluation {
  frameIndex: number;
  isStable: boolean;
  state: StabilityState;
  centerOfMass: ThreeVector3 | null;
  centerOfMassProjection: ThreeVector3 | null;
  supportPolygon: ThreeVector3[];
  contactLinkNames: string[];
  margin: number | null;
  totalMass: number;
}

export interface StabilityFrameRange {
  startFrame: number;
  endFrame: number;
  isStable: boolean;
  state: StabilityState;
}

export interface StabilityAnalyzerOptions {
  contactHeightThreshold?: number;
}

function getElementName(element: Element): string {
  return (element.localName || element.tagName || '').toLowerCase();
}

function findDirectChild(element: Element | null | undefined, name: string): Element | null {
  if (!element) {
    return null;
  }

  const targetName = name.toLowerCase();
  for (const child of Array.from(element.children ?? [])) {
    if (getElementName(child) === targetName) {
      return child;
    }
  }
  return null;
}

function parseNumberList(value: string | null, expectedLength: number): number[] | null {
  if (!value) {
    return null;
  }

  const values = value
    .trim()
    .split(/\s+/)
    .map((token) => Number(token));
  if (values.length < expectedLength || values.some((entry) => !Number.isFinite(entry))) {
    return null;
  }
  return values.slice(0, expectedLength);
}

function parseInertial(link: any): { mass: number; localCenterOfMass: ThreeVector3 } | null {
  const linkNode = link?.urdfNode as Element | null | undefined;
  const inertialNode = findDirectChild(linkNode, 'inertial');
  const massNode = findDirectChild(inertialNode, 'mass');
  const mass = Number(massNode?.getAttribute('value') ?? NaN);
  if (!Number.isFinite(mass) || mass <= 0) {
    return null;
  }

  const originNode = findDirectChild(inertialNode, 'origin');
  const xyz = parseNumberList(originNode?.getAttribute('xyz') ?? null, 3) ?? [0, 0, 0];
  return {
    mass,
    localCenterOfMass: new Vector3(xyz[0], xyz[1], xyz[2]),
  };
}

function getLinkName(mapName: string, link: any): string {
  return String(link?.urdfName || link?.name || mapName);
}

function getSupportScore(linkName: string): number {
  const normalized = linkName.toLowerCase();
  if (/(^|[_\-.])(foot|sole|toe)([_\-.]|$)/.test(normalized) || normalized.includes('foot')) {
    return 4;
  }
  if (normalized.includes('ankle_roll')) {
    return 3;
  }
  if (normalized.includes('ankle') && !normalized.includes('pitch')) {
    return 2;
  }
  return 0;
}

function collectMassLinks(robot: UrdfRobotLike): MassLinkSample[] {
  const links = (robot as any).links ?? {};
  const samples: MassLinkSample[] = [];
  for (const [mapName, link] of Object.entries(links)) {
    const inertial = parseInertial(link);
    if (!inertial) {
      continue;
    }
    samples.push({
      link,
      linkName: getLinkName(mapName, link),
      mass: inertial.mass,
      localCenterOfMass: inertial.localCenterOfMass,
    });
  }
  return samples;
}

function collectSupportLinks(robot: UrdfRobotLike): SupportLinkSample[] {
  const links = (robot as any).links ?? {};
  const scored: Array<SupportLinkSample & { score: number }> = [];
  for (const [mapName, link] of Object.entries(links)) {
    const linkName = getLinkName(mapName, link);
    const score = getSupportScore(linkName);
    if (score <= 0) {
      continue;
    }
    scored.push({ link, linkName, score });
  }

  if (scored.length === 0) {
    return Object.entries(links).map(([mapName, link]) => ({
      link,
      linkName: getLinkName(mapName, link),
    }));
  }

  const maxScore = Math.max(...scored.map((entry) => entry.score));
  return scored
    .filter((entry) => entry.score === maxScore)
    .map(({ link, linkName }) => ({ link, linkName }));
}

function cross2D(origin: ThreeVector2, a: ThreeVector2, b: ThreeVector2): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

export function computeConvexHull2D(points: readonly ThreeVector2[]): ThreeVector2[] {
  const unique = new Map<string, ThreeVector2>();
  for (const point of points) {
    const key = `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
    if (!unique.has(key)) {
      unique.set(key, point.clone());
    }
  }

  const sorted = [...unique.values()].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length <= 2) {
    return sorted;
  }

  const lower: ThreeVector2[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross2D(lower[lower.length - 2], lower[lower.length - 1], point) <= POLYGON_EPSILON
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: ThreeVector2[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (
      upper.length >= 2 &&
      cross2D(upper[upper.length - 2], upper[upper.length - 1], point) <= POLYGON_EPSILON
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function isPointInsideConvexPolygon(
  point: ThreeVector2,
  polygon: readonly ThreeVector2[],
  epsilon = POLYGON_EPSILON,
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const cross = cross2D(current, next, point);
    if (Math.abs(cross) <= epsilon) {
      continue;
    }
    const nextSign = Math.sign(cross);
    if (sign === 0) {
      sign = nextSign;
      continue;
    }
    if (sign !== nextSign) {
      return false;
    }
  }
  return true;
}

function distanceToSegment2D(point: ThreeVector2, start: ThreeVector2, end: ThreeVector2): number {
  const segment = end.clone().sub(start);
  const lengthSq = segment.lengthSq();
  if (lengthSq <= POLYGON_EPSILON) {
    return point.distanceTo(start);
  }

  const t = Math.max(0, Math.min(1, point.clone().sub(start).dot(segment) / lengthSq));
  return point.distanceTo(start.clone().add(segment.multiplyScalar(t)));
}

function computePolygonMargin(
  point: ThreeVector2,
  polygon: readonly ThreeVector2[],
  inside: boolean,
): number | null {
  if (polygon.length < 2) {
    return null;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    minDistance = Math.min(minDistance, distanceToSegment2D(point, current, next));
  }
  return inside ? minDistance : -minDistance;
}

export function buildStabilityFrameRanges(
  evaluations: readonly StabilityEvaluation[],
): StabilityFrameRange[] {
  if (evaluations.length === 0) {
    return [];
  }

  const ranges: StabilityFrameRange[] = [];
  let currentStart = evaluations[0].frameIndex;
  let currentEnd = evaluations[0].frameIndex;
  let currentStable = evaluations[0].isStable;
  let currentState = evaluations[0].state;

  for (let index = 1; index < evaluations.length; index += 1) {
    const evaluation = evaluations[index];
    if (evaluation.isStable === currentStable && evaluation.state === currentState) {
      currentEnd = evaluation.frameIndex;
      continue;
    }

    ranges.push({
      startFrame: currentStart,
      endFrame: currentEnd,
      isStable: currentStable,
      state: currentState,
    });
    currentStart = evaluation.frameIndex;
    currentEnd = evaluation.frameIndex;
    currentStable = evaluation.isStable;
    currentState = evaluation.state;
  }

  ranges.push({
    startFrame: currentStart,
    endFrame: currentEnd,
    isStable: currentStable,
    state: currentState,
  });
  return ranges;
}

export class StabilityAnalyzer {
  private readonly massLinks: MassLinkSample[];
  private readonly supportLinks: SupportLinkSample[];
  private readonly contactHeightThreshold: number;
  private readonly tempBox = new Box3();
  private readonly tempCenterOfMass = new Vector3();
  private readonly tempWorldCenter = new Vector3();
  private readonly tempLinkPosition = new Vector3();

  constructor(
    private readonly robot: UrdfRobotLike,
    options: StabilityAnalyzerOptions = {},
  ) {
    this.massLinks = collectMassLinks(robot);
    this.supportLinks = collectSupportLinks(robot);
    this.contactHeightThreshold =
      options.contactHeightThreshold ?? DEFAULT_CONTACT_HEIGHT_THRESHOLD;
  }

  hasMassData(): boolean {
    return this.massLinks.length > 0;
  }

  hasSupportCandidates(): boolean {
    return this.supportLinks.length > 0;
  }

  evaluateCurrentFrame(frameIndex: number, groundY: number): StabilityEvaluation {
    (this.robot as any).updateMatrixWorld?.(true);

    const centerOfMass = this.computeCenterOfMass();
    if (!centerOfMass) {
      return {
        frameIndex,
        isStable: false,
        state: 'no_mass',
        centerOfMass: null,
        centerOfMassProjection: null,
        supportPolygon: [],
        contactLinkNames: [],
        margin: null,
        totalMass: 0,
      };
    }

    const support = this.computeSupportPolygon(groundY);
    const projection = new Vector3(centerOfMass.x, groundY + 0.004, centerOfMass.z);
    if (support.polygon.length < 3) {
      return {
        frameIndex,
        isStable: false,
        state: 'no_support',
        centerOfMass,
        centerOfMassProjection: projection,
        supportPolygon: support.polygon,
        contactLinkNames: support.contactLinkNames,
        margin: null,
        totalMass: support.totalMass,
      };
    }

    const point2D = new Vector2(centerOfMass.x, centerOfMass.z);
    const polygon2D = support.polygon.map((point) => new Vector2(point.x, point.z));
    const isStable = isPointInsideConvexPolygon(point2D, polygon2D);
    return {
      frameIndex,
      isStable,
      state: isStable ? 'inside' : 'outside',
      centerOfMass,
      centerOfMassProjection: projection,
      supportPolygon: support.polygon,
      contactLinkNames: support.contactLinkNames,
      margin: computePolygonMargin(point2D, polygon2D, isStable),
      totalMass: support.totalMass,
    };
  }

  private computeCenterOfMass(): ThreeVector3 | null {
    let totalMass = 0;
    this.tempCenterOfMass.set(0, 0, 0);

    for (const sample of this.massLinks) {
      if (!sample.link?.matrixWorld) {
        continue;
      }
      this.tempWorldCenter.copy(sample.localCenterOfMass).applyMatrix4(sample.link.matrixWorld);
      this.tempCenterOfMass.addScaledVector(this.tempWorldCenter, sample.mass);
      totalMass += sample.mass;
    }

    if (totalMass <= 0) {
      return null;
    }

    return this.tempCenterOfMass.clone().divideScalar(totalMass);
  }

  private computeSupportPolygon(groundY: number): {
    polygon: ThreeVector3[];
    contactLinkNames: string[];
    totalMass: number;
  } {
    const linkBoxes = this.supportLinks
      .map((sample) => {
        const box = new Box3();
        box.expandByObject(sample.link, true);
        return { ...sample, box };
      })
      .filter((entry) => entry.link && !entry.box.isEmpty());

    const candidates = linkBoxes.length > 0 ? linkBoxes : this.supportLinks.map((sample) => ({
      ...sample,
      box: null,
    }));

    let contacts = candidates.filter((entry) => {
      if (!entry.box) {
        return true;
      }
      return entry.box.min.y <= groundY + this.contactHeightThreshold;
    });

    if (contacts.length === 0 && linkBoxes.length > 0) {
      const minY = Math.min(...linkBoxes.map((entry) => entry.box.min.y));
      contacts = linkBoxes.filter(
        (entry) => entry.box.min.y <= minY + this.contactHeightThreshold,
      );
    }

    const points: ThreeVector2[] = [];
    const contactLinkNames: string[] = [];
    for (const contact of contacts) {
      contactLinkNames.push(contact.linkName);
      if (contact.box && !contact.box.isEmpty()) {
        points.push(
          new Vector2(contact.box.min.x, contact.box.min.z),
          new Vector2(contact.box.min.x, contact.box.max.z),
          new Vector2(contact.box.max.x, contact.box.min.z),
          new Vector2(contact.box.max.x, contact.box.max.z),
        );
        continue;
      }

      contact.link?.getWorldPosition?.(this.tempLinkPosition);
      points.push(
        new Vector2(
          this.tempLinkPosition.x - DEFAULT_FOOT_HALF_LENGTH,
          this.tempLinkPosition.z - DEFAULT_FOOT_HALF_WIDTH,
        ),
        new Vector2(
          this.tempLinkPosition.x - DEFAULT_FOOT_HALF_LENGTH,
          this.tempLinkPosition.z + DEFAULT_FOOT_HALF_WIDTH,
        ),
        new Vector2(
          this.tempLinkPosition.x + DEFAULT_FOOT_HALF_LENGTH,
          this.tempLinkPosition.z - DEFAULT_FOOT_HALF_WIDTH,
        ),
        new Vector2(
          this.tempLinkPosition.x + DEFAULT_FOOT_HALF_LENGTH,
          this.tempLinkPosition.z + DEFAULT_FOOT_HALF_WIDTH,
        ),
      );
    }

    const hull = computeConvexHull2D(points);
    return {
      polygon: hull.map((point) => new Vector3(point.x, groundY + 0.008, point.y)),
      contactLinkNames,
      totalMass: this.massLinks.reduce((sum, sample) => sum + sample.mass, 0),
    };
  }
}
