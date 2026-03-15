import { DirectionalLight, Group, Mesh, MeshPhongMaterial, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import { stripEmbeddedSceneLights } from './UrdfLoadService';

describe('UrdfLoadService', () => {
  it('removes embedded lights from imported collada scenes', () => {
    const root = new Group();
    const nested = new Group();
    const mesh = new Mesh(new SphereGeometry(1), new MeshPhongMaterial());
    const light = new DirectionalLight('#ffffff', 3);

    nested.add(mesh);
    nested.add(light);
    root.add(nested);

    const sanitized = stripEmbeddedSceneLights(root);

    expect(sanitized).toBe(root);
    expect(light.parent).toBeNull();
    expect(nested.children).toContain(mesh);
    expect(nested.children).not.toContain(light);
  });
});
