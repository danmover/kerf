// Depth of a rebuilt part's old and new meshes as the view sees them, for the part shader's test of which surfaces
// changed (kChangedHere in partShader.ts): a fragment of the new mesh lying on the old mesh's surface hasn't changed,
// and the old mesh's fragments lying on the new one's are left to the new one. Only the meshes of parts that are
// changing are drawn, for the second or so the change shows, and only their depth.

import * as THREE from "three";

export class ChangeDepth {
  private rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private mat = new THREE.MeshBasicMaterial({ colorWrite: false });

  constructor(private r: THREE.WebGLRenderer) {}

  /** Draw the old meshes' depth (which the new ones test against) and the new ones' (which the old ones test against). */
  draw(camera: THREE.Camera, width: number, height: number, olds: THREE.Mesh[], news: THREE.Mesh[]): { old: THREE.Texture; new: THREE.Texture } {
    this.rts ??= [target(width, height), target(width, height)];
    for (const rt of this.rts) if (rt.width !== width || rt.height !== height) rt.setSize(width, height);
    const prev = this.r.getRenderTarget();
    this.drawInto(this.rts[0], olds, camera);
    this.drawInto(this.rts[1], news, camera);
    this.r.setRenderTarget(prev);
    return { old: this.rts[0].depthTexture!, new: this.rts[1].depthTexture! };
  }

  private drawInto(rt: THREE.WebGLRenderTarget, meshes: THREE.Mesh[], camera: THREE.Camera) {
    this.r.setRenderTarget(rt);
    this.r.clear(false, true, false);
    for (const m of meshes) {
      const own = m.material as THREE.Material;
      // the true surface, so no polygon offset; cut where the part is cut
      this.mat.side = own.side;
      this.mat.clippingPlanes = own.clippingPlanes;
      // The mesh alone. What hangs on it (its rounded edges) is drawn with the part's own material, and drawn here,
      // as a scene of one mesh with no lights in it, that material needs a shader of its own: the card would build
      // the parts' large shader once more for it, seconds on Direct3D, with the picture waiting.
      const shown = m.children.filter((c) => c.visible);
      for (const c of shown) c.visible = false;
      m.material = this.mat;
      m.updateWorldMatrix(true, false);
      this.r.render(m, camera);
      m.material = own;
      for (const c of shown) c.visible = true;
    }
  }

  dispose() {
    for (const rt of this.rts ?? []) {
      rt.depthTexture?.dispose();
      rt.dispose();
    }
    this.rts = null;
    this.mat.dispose();
  }
}

function target(w: number, h: number) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType });
  rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  return rt;
}
