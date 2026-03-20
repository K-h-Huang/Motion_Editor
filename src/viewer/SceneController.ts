import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  Group,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshPhongMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  SRGBColorSpace,
  Scene,
  ShadowMaterial,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { UrdfRobotLike, ViewMode } from '../types/viewer';

const HALF_PI = Math.PI / 2;
const GRID_BASE_SIZE = 20;
const MIN_GRID_COVERAGE = 30;
const DEFAULT_FIT_OFFSET = 1.8;
const DEFAULT_KEY_LIGHT_OFFSET = new Vector3(4, 10, 1);
const SMPL_KEY_LIGHT_OFFSET = new Vector3(3.6, 5.8, 2.6);
const DEFAULT_FILL_LIGHT_POSITION = new Vector3(-2.2, 3.1, -2.4);
const DEFAULT_RIM_LIGHT_POSITION = new Vector3(0, 4, -5);
const SMPL_FILL_LIGHT_OFFSET = new Vector3(-3.1, 3.6, 2.7);
const SMPL_RIM_LIGHT_OFFSET = new Vector3(2.8, 2.9, -3.0);
const DARK_COLOR_EPSILON = 0.06;
const ROOT_TRACK_JOINT_NAME = 'floating_base_joint';
type SceneVisualProfile = 'default' | 'smpl';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isWithinUrdfCollider(node: any): boolean {
  let current = node;
  while (current) {
    if (current.isURDFCollider) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function getSafeMaterialColor(candidate: any): any {
  const fallbackColor = new Color('#d7e0e8');
  const sourceColor = candidate?.color?.clone?.() ?? fallbackColor.clone();
  const luminance =
    sourceColor.r * 0.2126 + sourceColor.g * 0.7152 + sourceColor.b * 0.0722;

  // Only rescue clearly broken unlit imports; preserve intentional dark Lambert/Phong assets.
  if (
    candidate?.isMeshBasicMaterial &&
    !candidate?.map &&
    luminance < DARK_COLOR_EPSILON
  ) {
    return fallbackColor;
  }

  return sourceColor;
}

function disposeMaterial(material: unknown): void {
  if (!material || typeof material !== 'object') {
    return;
  }

  const disposable = material as { dispose?: () => void };
  disposable.dispose?.();
}

function disposeObjectTree(object: UrdfRobotLike): void {
  object.traverse((child: unknown) => {
    const maybeMesh = child as any & {
      geometry?: { dispose?: () => void };
      material?: unknown | unknown[];
    };

    maybeMesh.geometry?.dispose?.();

    if (Array.isArray(maybeMesh.material)) {
      maybeMesh.material.forEach((material: unknown) => disposeMaterial(material));
    } else {
      disposeMaterial(maybeMesh.material);
    }
  });
}

export function getModelRootRotationX(up: '+Z' | '+Y'): number {
  return up === '+Z' ? -HALF_PI : 0;
}

export function computeCameraDistance(
  maxDimension: number,
  fovDegrees: number,
  fitOffset = DEFAULT_FIT_OFFSET,
): number {
  const safeDimension = Math.max(maxDimension, 0.01);
  const safeFov = clamp(fovDegrees, 10, 120);
  const fitHeightDistance =
    safeDimension / (2 * Math.tan((safeFov * Math.PI) / 180 / 2));
  return Math.max(fitHeightDistance * fitOffset, safeDimension * 1.15, 0.8);
}

export function computeGridScale(maxDimension: number, baseSize = GRID_BASE_SIZE): number {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    return MIN_GRID_COVERAGE / baseSize;
  }

  const desiredCoverage = Math.max(maxDimension * 3.2, MIN_GRID_COVERAGE);
  const rawScale = desiredCoverage / baseSize;
  return clamp(rawScale, MIN_GRID_COVERAGE / baseSize, 40);
}

export function evaluateScaleWarning(maxDimension: number): string | null {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    return 'Model bounds are invalid. Check if meshes were loaded correctly.';
  }

  if (maxDimension < 0.1) {
    return `Model is very small (${maxDimension.toFixed(4)} units). Scale may be in millimeters.`;
  }

  if (maxDimension > 30) {
    return `Model is very large (${maxDimension.toFixed(2)} units). Scale may be oversized.`;
  }

  return null;
}

export class SceneController {
  public onViewWarning: ((warning: string | null) => void) | null = null;

  private readonly scene: any;
  private readonly camera: any;
  private readonly renderer: any;
  private readonly controls: any;
  private readonly canvas: HTMLCanvasElement;
  private readonly modelRoot: any;
  private readonly hemisphereLight: any;
  private readonly keyLight: any;
  private readonly fillLight: any;
  private readonly rimLight: any;
  private readonly keyLightOffset: any;
  private readonly groundPlane: any;
  private readonly referenceGrid: any;
  private readonly pmremGenerator: any;
  private readonly environmentMapTarget: any;
  private currentRobot: UrdfRobotLike | null = null;
  private visualNodes: any[] = [];
  private collisionNodes: any[] = [];
  private modelUpAxis: '+Z' | '+Y' = '+Z';
  private viewMode: ViewMode = 'root_lock';
  private showVisual = true;
  private showCollision = false;
  private currentVisualProfile: SceneVisualProfile = 'default';
  private animationFrameId = 0;
  private readonly tempTrackTarget = new Vector3();
  private readonly tempCameraOffset = new Vector3();
  
  // 用于射线检测的对象
  private readonly raycaster = new Raycaster();
  private readonly mouse = new Vector2();
  
  // 用于存储当前悬停的关节
  private hoveredJointName: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.scene = new Scene();
    this.scene.background = new Color('#07121a');

    this.camera = new PerspectiveCamera(75, 1, 0.05, 500);
    this.camera.position.set(2, 2, 2);

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.0;
    this.controls.target.set(0, 0, 0);

    // 添加鼠标点击事件监听器
    this.canvas.addEventListener('click', (event) => {
      // 计算鼠标在归一化设备坐标中的位置
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      
      // 处理鼠标点击
      this.handleMouseClick();
    });

    this.pmremGenerator = null;
    this.environmentMapTarget = null;
    try {
      this.pmremGenerator = new PMREMGenerator(this.renderer);
      this.pmremGenerator.compileEquirectangularShader();
      const envScene = new Scene();
      envScene.add(new HemisphereLight('#ffffff', '#45505f', 1.0));
      const envKeyLight = new DirectionalLight('#ffffff', 0.8);
      envKeyLight.position.set(3, 5, 2);
      envScene.add(envKeyLight);
      this.environmentMapTarget = this.pmremGenerator.fromScene(envScene, 0.05);
      this.scene.environment = this.environmentMapTarget?.texture ?? null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`PMREM environment disabled: ${reason}`);
      this.pmremGenerator?.dispose?.();
      this.pmremGenerator = null;
      this.environmentMapTarget = null;
      this.scene.environment = null;
    }

    this.hemisphereLight = new HemisphereLight('#ffffff', '#21313d', 0.55);
    this.hemisphereLight.position.set(0, 1, 0);
    this.scene.add(this.hemisphereLight);

    this.keyLightOffset = DEFAULT_KEY_LIGHT_OFFSET.clone();
    this.keyLight = new DirectionalLight('#ffffff', Math.PI);
    this.keyLight.position.copy(this.keyLightOffset);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.1;
    this.keyLight.shadow.camera.far = 80;
    this.keyLight.shadow.normalBias = 0.001;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new DirectionalLight('#d2e8ff', Math.PI * 0.34);
    this.fillLight.position.copy(DEFAULT_FILL_LIGHT_POSITION);
    this.scene.add(this.fillLight);

    this.rimLight = new DirectionalLight('#9ec9ff', Math.PI * 0.14);
    this.rimLight.position.copy(DEFAULT_RIM_LIGHT_POSITION);
    this.scene.add(this.rimLight);

    this.modelRoot = new Group();
    this.modelRoot.name = 'model-root';
    this.scene.add(this.modelRoot);

    this.groundPlane = new Mesh(
      new PlaneGeometry(GRID_BASE_SIZE, GRID_BASE_SIZE),
      new ShadowMaterial({
        transparent: true,
        opacity: 0.24,
      }),
    );
    this.groundPlane.rotation.x = -HALF_PI;
    this.groundPlane.receiveShadow = true;
    this.groundPlane.castShadow = false;
    this.groundPlane.position.y = 0;
    this.groundPlane.visible = true;
    this.scene.add(this.groundPlane);

    this.referenceGrid = new GridHelper(GRID_BASE_SIZE, 20, '#4b7a95', '#26485c');
    this.referenceGrid.position.y = 0;
    const gridMaterials = Array.isArray(this.referenceGrid.material)
      ? this.referenceGrid.material
      : [this.referenceGrid.material];
    for (const material of gridMaterials) {
      material.opacity = 0.92;
      material.transparent = true;
      material.depthWrite = false;
    }
    this.referenceGrid.renderOrder = 1;
    this.scene.add(this.referenceGrid);

    this.setModelUpAxis('+Z');
    this.setVisualProfile('default');

    this.animate = this.animate.bind(this);
    this.animate();
  }

  setModelUpAxis(up: '+Z' | '+Y'): void {
    this.modelUpAxis = up;
    this.modelRoot.rotation.set(getModelRootRotationX(up), 0, 0);
    this.modelRoot.updateMatrixWorld(true);
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (mode === 'root_lock') {
      this.syncViewToCurrentRobot();
    }
  }

  setVisualProfile(profile: SceneVisualProfile): void {
    this.currentVisualProfile = profile;
    const groundMaterial = this.groundPlane.material as any;

    if (profile === 'smpl') {
      this.scene.background = new Color('#07121a');
      this.scene.environment = this.environmentMapTarget?.texture ?? null;
      this.renderer.toneMappingExposure = 1.0;

      this.hemisphereLight.color.set('#ffffff');
      this.hemisphereLight.groundColor.set('#d4d4d4');
      this.hemisphereLight.intensity = 0.82;

      this.keyLight.color.set('#fffdf8');
      this.keyLight.intensity = 1.38;
      this.keyLightOffset.copy(SMPL_KEY_LIGHT_OFFSET);

      this.fillLight.color.set('#ffffff');
      this.fillLight.intensity = 1.08;

      this.rimLight.color.set('#fff6ef');
      this.rimLight.intensity = 0.82;

      this.referenceGrid.visible = true;
      if (groundMaterial) {
        groundMaterial.opacity = 0.24;
        groundMaterial.color?.set?.('#000000');
        groundMaterial.needsUpdate = true;
      }
    } else {
      this.scene.background = new Color('#07121a');
      this.scene.environment = this.environmentMapTarget?.texture ?? null;
      this.renderer.toneMappingExposure = 1.0;

      this.hemisphereLight.color.set('#ffffff');
      this.hemisphereLight.groundColor.set('#21313d');
      this.hemisphereLight.intensity = 0.55;

      this.keyLight.color.set('#ffffff');
      this.keyLight.intensity = Math.PI;
      this.keyLightOffset.copy(DEFAULT_KEY_LIGHT_OFFSET);

      this.fillLight.color.set('#d2e8ff');
      this.fillLight.intensity = Math.PI * 0.34;
      this.fillLight.position.copy(DEFAULT_FILL_LIGHT_POSITION);

      this.rimLight.color.set('#9ec9ff');
      this.rimLight.intensity = Math.PI * 0.14;
      this.rimLight.position.copy(DEFAULT_RIM_LIGHT_POSITION);

      this.referenceGrid.visible = true;
      if (groundMaterial) {
        groundMaterial.opacity = 0.24;
        groundMaterial.color?.set?.('#000000');
        groundMaterial.needsUpdate = true;
      }
    }

    if (this.currentRobot) {
      const box = this.computeRobotBounds(this.currentRobot);
      if (box) {
        const center = box.getCenter(new Vector3());
        this.updateKeyLightForBounds(box, center);
        this.updateGroundAndGrid(box);
      }
    } else {
      this.keyLight.position.copy(this.keyLightOffset);
      this.keyLight.target.position.set(0, 0, 0);
      this.keyLight.target.updateMatrixWorld();
    }
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  setRobot(robot: UrdfRobotLike): void {
    this.clearRobot();
    this.currentRobot = robot;
    this.modelRoot.add(robot);

    this.applyMeshDefaults(robot);
    this.collectGeometryNodes(robot);
    this.setGeometryVisibility(this.showVisual, this.showCollision);

    const box = this.frameRobot(robot);
    if (box) {
      this.updateGroundAndGrid(box);
    }
    this.syncViewToCurrentRobot();
  }

  setGeometryVisibility(showVisual: boolean, showCollision: boolean): void {
    this.showVisual = showVisual;
    this.showCollision = showCollision;

    for (const node of this.visualNodes) {
      node.visible = showVisual;
    }

    for (const node of this.collisionNodes) {
      node.visible = showCollision;
    }

    if (this.currentRobot) {
      const box = this.computeRobotBounds(this.currentRobot);
      if (box) {
        this.updateGroundAndGrid(box);
      }
    }
  }

  clearRobot(): void {
    if (!this.currentRobot) {
      return;
    }

    this.modelRoot.remove(this.currentRobot);
    disposeObjectTree(this.currentRobot);
    this.currentRobot = null;
    this.visualNodes = [];
    this.collisionNodes = [];
    this.referenceGrid.scale.setScalar(1);
    this.referenceGrid.position.y = 0;
    this.groundPlane.scale.setScalar(1);
    this.groundPlane.position.y = 0;
    this.emitWarning(null);
  }

  frameRobot(robot: UrdfRobotLike | null = this.currentRobot): any | null {
    if (!robot) {
      return null;
    }

    const box = this.computeRobotBounds(robot);
    if (!box) {
      return null;
    }

    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 0.01);
    const distance = computeCameraDistance(maxDimension, this.camera.fov, DEFAULT_FIT_OFFSET);
    const horizontalAngle = (Math.PI * 3) / 4;
    const verticalAngle = Math.PI / 6;
    const cameraOffset = new Vector3(
      distance * Math.cos(verticalAngle) * Math.sin(horizontalAngle),
      distance * Math.sin(verticalAngle),
      -distance * Math.cos(verticalAngle) * Math.cos(horizontalAngle),
    );

    this.controls.target.copy(center);
    this.camera.position.copy(center).add(cameraOffset);
    this.camera.near = Math.max(0.01, distance / 120);
    this.camera.far = Math.max(200, distance * 55);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.updateKeyLightForBounds(box, center);
    this.emitWarning(evaluateScaleWarning(maxDimension));
    return box;
  }

  updateGroundAndGrid(box: any): void {
    if (box.isEmpty()) {
      return;
    }

    const size = box.getSize(new Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 0.01);
    const gridScale = computeGridScale(maxDimension);
    this.referenceGrid.scale.setScalar(gridScale);
    this.referenceGrid.position.y = box.min.y + 0.0005;

    this.groundPlane.scale.setScalar(gridScale);
    this.groundPlane.position.y = box.min.y + 0.0001;
  }

  syncGroundToCurrentRobot(): void {
    if (!this.currentRobot) {
      return;
    }

    const box = this.computeRobotBounds(this.currentRobot);
    if (!box) {
      return;
    }

    this.updateGroundAndGrid(box);
  }

  syncViewToCurrentRobot(): void {
    if (this.viewMode !== 'root_lock' || !this.currentRobot) {
      return;
    }

    const target = this.getRootTrackingTarget(this.currentRobot);
    if (!target) {
      return;
    }

    this.tempCameraOffset.copy(this.camera.position).sub(this.controls.target);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(this.tempCameraOffset);
    this.controls.update();
  }

  resize(): void {
    const size = new Vector2();
    this.renderer.getSize(size);
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const aspect = width / height;

    if (size.x === width && size.y === height && Math.abs(this.camera.aspect - aspect) < 1e-6) {
      return;
    }

    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  resetView(): void {
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(2, 2, 2);
    this.camera.near = 0.05;
    this.camera.far = 500;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrameId);
    this.controls.dispose();
    this.clearRobot();

    this.referenceGrid.geometry?.dispose?.();
    if (Array.isArray(this.referenceGrid.material)) {
      this.referenceGrid.material.forEach((material: unknown) => disposeMaterial(material));
    } else {
      disposeMaterial(this.referenceGrid.material);
    }

    this.groundPlane.geometry?.dispose?.();
    disposeMaterial(this.groundPlane.material);

    this.environmentMapTarget?.dispose?.();
    this.pmremGenerator?.dispose?.();

    this.renderer.dispose();
  }

  private applyMeshDefaults(robot: UrdfRobotLike): void {
    robot.traverse((child: unknown) => {
      const maybeMesh = child as any;
      if (!maybeMesh.isMesh) {
        return;
      }

      const isColliderMesh = isWithinUrdfCollider(maybeMesh);
      if (isColliderMesh) {
        this.applyCollisionMaterial(maybeMesh);
        return;
      }

      if (maybeMesh.userData?.skipMaterialEnhance) {
        maybeMesh.castShadow = maybeMesh.userData.castShadow ?? true;
        maybeMesh.receiveShadow = maybeMesh.userData.receiveShadow ?? true;
        return;
      }

      maybeMesh.castShadow = true;
      maybeMesh.receiveShadow = true;

      if (Array.isArray(maybeMesh.material)) {
        maybeMesh.material = maybeMesh.material.map((material: unknown) =>
          this.enhanceMaterial(material),
        );
      } else {
        maybeMesh.material = this.enhanceMaterial(maybeMesh.material);
      }
    });
  }

  private collectGeometryNodes(robot: UrdfRobotLike): void {
    const visualNodes = new Set<any>();
    const collisionNodes = new Set<any>();
    const visualMeshes = new Set<any>();
    const collisionMeshes = new Set<any>();

    robot.traverse((child: unknown) => {
      const node = child as any & {
        isURDFVisual?: boolean;
        isURDFCollider?: boolean;
        isMesh?: boolean;
      };

      if (node.isURDFCollider) {
        collisionNodes.add(node);
      } else if (node.isURDFVisual) {
        visualNodes.add(node);
      }

      if (node.isMesh) {
        if (isWithinUrdfCollider(node)) {
          collisionMeshes.add(node);
        } else {
          visualMeshes.add(node);
        }
      }
    });

    this.visualNodes = visualNodes.size > 0 ? [...visualNodes] : [...visualMeshes];
    this.collisionNodes = collisionNodes.size > 0 ? [...collisionNodes] : [...collisionMeshes];
  }

  private animate(): void {
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.resize();
    this.renderer.render(this.scene, this.camera);
  }

  // 处理鼠标点击事件
  private handleMouseClick(): void {
    if (!this.currentRobot) {
      return;
    }

    // 更新射线检测
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // 计算射线与机器人模型的交点
    const intersects = this.raycaster.intersectObject(this.currentRobot, true);

    if (intersects.length > 0) {
      // 找到第一个交点
      const intersect = intersects[0];
      const object = intersect.object;

      // 查找包含该对象的关节
      const jointName = this.findJointForObject(object);
      if (jointName) {
        // 清除之前的高亮
        this.clearJointHighlights();
        // 高亮点击的关节
        this.highlightJoint(jointName);
      }
    }
  }

  // 查找包含指定对象的关节
  private findJointForObject(object: any): string | null {
    if (!this.currentRobot) {
      console.log('No robot found');
      return null;
    }

    const robotAny = this.currentRobot as any;
    if (!robotAny.joints) {
      console.log('No joints found in robot');
      return null;
    }

    console.log('Looking for joint for object:', object.name);
    console.log('Robot has', Object.keys(robotAny.joints).length, 'joints');

    // 方式1: 从对象向上遍历，查找包含该对象的关节
    let current = object;
    while (current) {
      for (const jointName in robotAny.joints) {
        const joint = robotAny.joints[jointName];
        
        // 尝试多种方式查找关节对应的链接
        let link = null;
        if (joint.link) {
          link = joint.link;
        } else if (joint.childLink) {
          link = joint.childLink;
        } else if (joint.children && joint.children.length > 0) {
          link = joint.children[0];
        }

        if (link === current) {
          console.log('Found joint', jointName, 'by traversing up from object', object.name);
          return jointName;
        }
      }
      current = current.parent;
    }

    // 方式2: 遍历所有关节，查找包含该对象的关节
    for (const jointName in robotAny.joints) {
      const joint = robotAny.joints[jointName];
      
      // 尝试多种方式查找关节对应的链接
      let link = null;
      if (joint.link) {
        link = joint.link;
        console.log('Joint', jointName, 'has link:', link.name);
      } else if (joint.childLink) {
        link = joint.childLink;
        console.log('Joint', jointName, 'has childLink:', link.name);
      } else if (joint.children && joint.children.length > 0) {
        link = joint.children[0];
        console.log('Joint', jointName, 'has children[0]:', link.name);
      } else {
        console.log('Joint', jointName, 'has no link, childLink, or children');
        continue;
      }

      // 检查对象是否在链接的层级结构中
      let found = false;
      link.traverse((child: any) => {
        if (child === object) {
          found = true;
          console.log('Found object', object.name, 'in joint', jointName);
        }
      });

      if (found) {
        return jointName;
      }
    }

    console.log('No joint found for object:', object.name);
    return null;
  }

  private enhanceMaterial(material: unknown): unknown {
    const candidate = material as any;
    if (!candidate || typeof candidate !== 'object') {
      return material;
    }

    if (candidate.map) {
      candidate.map.colorSpace = SRGBColorSpace;
    }

    if (candidate.isMeshBasicMaterial || candidate.isMeshLambertMaterial) {
      return new MeshPhongMaterial({
        color: getSafeMaterialColor(candidate),
        map: candidate.map ?? null,
        transparent: Boolean(candidate.transparent),
        opacity: candidate.opacity ?? 1,
        side: candidate.side,
        flatShading: Boolean(candidate.flatShading),
        wireframe: Boolean(candidate.wireframe),
        vertexColors: Boolean(candidate.vertexColors),
        shininess: 48,
        specular: new Color(0.3, 0.3, 0.3),
        emissive: new Color(0.03, 0.03, 0.03),
        envMap: this.scene.environment ?? null,
        reflectivity: this.scene.environment ? 0.26 : 0,
      });
    }

    if (candidate.isMeshPhongMaterial) {
      if (candidate.shininess === undefined || candidate.shininess < 42) {
        candidate.shininess = 42;
      }
      if (!candidate.specular) {
        candidate.specular = new Color(0.24, 0.24, 0.24);
      }
      if (!candidate.emissive) {
        candidate.emissive = new Color(0.02, 0.02, 0.02);
      }
      if (this.scene.environment && !candidate.envMap) {
        candidate.envMap = this.scene.environment;
        candidate.reflectivity = candidate.reflectivity ?? 0.2;
      }
      candidate.needsUpdate = true;
      return candidate;
    }

    if (candidate.isMeshStandardMaterial) {
      // Keep original PBR values to avoid unexpected darkening on imported assets.
      if (this.scene.environment && !candidate.envMap) {
        candidate.envMap = this.scene.environment;
        candidate.envMapIntensity = candidate.envMapIntensity ?? 0.85;
      }
      candidate.needsUpdate = true;
      return candidate;
    }

    return candidate;
  }

  private applyCollisionMaterial(mesh: any): void {
    if (!mesh.userData.__collisionMaterialApplied) {
      mesh.material = new MeshPhongMaterial({
        transparent: true,
        opacity: 0.35,
        shininess: 2.5,
        premultipliedAlpha: true,
        color: 0xffbe38,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      mesh.userData.__collisionMaterialApplied = true;
    }

    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }

  private getFramingTargets(robot: UrdfRobotLike): any[] {
    const targets: any[] = [];

    if (this.showVisual) {
      targets.push(...this.visualNodes);
    }
    if (this.showCollision) {
      targets.push(...this.collisionNodes);
    }

    if (targets.length > 0) {
      return targets;
    }
    if (this.visualNodes.length > 0) {
      return [...this.visualNodes];
    }
    if (this.collisionNodes.length > 0) {
      return [...this.collisionNodes];
    }

    return [robot];
  }

  private computeRobotBounds(robot: UrdfRobotLike): any | null {
    this.modelRoot.updateMatrixWorld(true);

    const targets = this.getFramingTargets(robot);
    const box = new Box3();
    for (const target of targets) {
      box.expandByObject(target, true);
    }

    if (box.isEmpty()) {
      box.setFromObject(this.modelRoot, true);
    }

    if (box.isEmpty()) {
      return null;
    }

    return box;
  }

  private getRootTrackingTarget(robot: UrdfRobotLike): any | null {
    this.modelRoot.updateMatrixWorld(true);

    const robotAny = robot as any;
    const rootJoint = robotAny.joints?.[ROOT_TRACK_JOINT_NAME];
    if (rootJoint && typeof rootJoint.getWorldPosition === 'function') {
      rootJoint.getWorldPosition(this.tempTrackTarget);
      return this.tempTrackTarget;
    }

    const rootTrackNode = robotAny.userData?.rootTrackNode;
    if (rootTrackNode && typeof rootTrackNode.getWorldPosition === 'function') {
      rootTrackNode.getWorldPosition(this.tempTrackTarget);
      return this.tempTrackTarget;
    }

    if (typeof robotAny.getWorldPosition === 'function') {
      robotAny.getWorldPosition(this.tempTrackTarget);
      return this.tempTrackTarget;
    }

    const bounds = this.computeRobotBounds(robot);
    if (!bounds) {
      return null;
    }

    bounds.getCenter(this.tempTrackTarget);
    return this.tempTrackTarget;
  }

  private updateKeyLightForBounds(box: any, center: any): void {
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 1);

    const shadowCamera = this.keyLight.shadow.camera;
    shadowCamera.left = -radius;
    shadowCamera.right = radius;
    shadowCamera.top = radius;
    shadowCamera.bottom = -radius;
    shadowCamera.far = Math.max(40, radius * 8);

    this.keyLight.target.position.copy(center);
    this.keyLight.position.copy(center).add(this.keyLightOffset);
    this.keyLight.target.updateMatrixWorld();

    if (this.currentVisualProfile === 'smpl') {
      this.fillLight.position.copy(center).add(SMPL_FILL_LIGHT_OFFSET);
      this.rimLight.position.copy(center).add(SMPL_RIM_LIGHT_OFFSET);
    }

    shadowCamera.updateProjectionMatrix();
  }

  private emitWarning(warning: string | null): void {
    this.onViewWarning?.(warning);
  }

  // 高亮指定关节
  highlightJoint(jointName: string): void {
    if (!this.currentRobot) {
      console.log('No robot found for highlighting');
      return;
    }

    // 先清除所有关节的高亮
    this.clearJointHighlights();

    // 查找并高亮指定关节
    const robotAny = this.currentRobot as any;
    console.log('Highlighting joint:', jointName);

    if (robotAny.joints && robotAny.joints[jointName]) {
      const joint = robotAny.joints[jointName];
      console.log('Found joint:', jointName);
      
      // 尝试多种方式查找关节对应的链接
      let link = null;
      
      // 方式1: 直接访问link属性
      if (joint.link) {
        link = joint.link;
        console.log('Found link via joint.link:', link.name);
      }
      // 方式2: 访问childLink属性
      else if (joint.childLink) {
        link = joint.childLink;
        console.log('Found link via joint.childLink:', link.name);
      }
      // 方式3: 访问children属性
      else if (joint.children && joint.children.length > 0) {
        link = joint.children[0];
        console.log('Found link via joint.children[0]:', link.name);
      }
      // 方式4: 尝试访问joint对象本身
      else {
        console.log('Joint has no link, childLink, or children, trying joint itself');
        link = joint;
      }
      
      if (link) {
        let meshFound = false;
        
        // 只处理当前链接的直接子网格，不递归遍历所有子节点
        // 这样可以避免高亮后续的关节链接
        link.children.forEach((child: any) => {
          if (child.isMesh) {
            meshFound = true;
            console.log('Found direct mesh:', child.name);
            // 保存原始材质
            if (!child.userData.originalMaterial) {
              child.userData.originalMaterial = child.material;
            }
            // 创建高亮材质
            child.material = new MeshPhongMaterial({
              color: 0x00ff00,
              emissive: 0x00ff00,
              shininess: 100,
              transparent: true,
              opacity: 0.8,
              envMap: this.scene.environment ?? null,
              reflectivity: 0.5
            });
          }
        });
        
        if (!meshFound) {
          console.log('No direct meshes found in link');
          
          // 如果当前链接没有直接网格，尝试查找第一个包含网格的子节点
          // 但只递归一层，避免高亮太多
          const findFirstMesh = (node: any): boolean => {
            for (let i = 0; i < node.children.length; i++) {
              const child = node.children[i];
              if (child.isMesh) {
                console.log('Found first mesh in link hierarchy:', child.name);
                // 保存原始材质
                if (!child.userData.originalMaterial) {
                  child.userData.originalMaterial = child.material;
                }
                // 创建高亮材质
                child.material = new MeshPhongMaterial({
                  color: 0x00ff00,
                  emissive: 0x00ff00,
                  shininess: 100,
                  transparent: true,
                  opacity: 0.8,
                  envMap: this.scene.environment ?? null,
                  reflectivity: 0.5
                });
                return true;
              }
              // 只递归一层，避免高亮太多
              if (findFirstMesh(child)) {
                return true;
              }
            }
            return false;
          };
          
          findFirstMesh(link);
        }
      } else {
        console.log('Joint has no link or childLink');
      }
    } else {
      console.log('Joint not found:', jointName);
    }
  }

  // 清除所有关节的高亮
  clearJointHighlights(): void {
    if (!this.currentRobot) {
      return;
    }

    this.currentRobot.traverse((child: any) => {
      if (child.isMesh && child.userData.originalMaterial) {
        child.material = child.userData.originalMaterial;
        delete child.userData.originalMaterial;
      }
    });
  }
}
