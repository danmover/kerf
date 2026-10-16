// A dimension line between two points (the closest points of two selected
// parts), drawn over the model so a gap stays visible from any angle.

import * as THREE from "three";
import type { V3 } from "../../kernel/recipe";
import { currentTheme } from "../../app/theme";

// teal on the dark backdrop; the light theme's pale one needs a deeper teal
const COLOR = { dark: new THREE.Color("#4fd1c5"), light: new THREE.Color("#0c8d83") };

/** Keep an object on the theme's colour, checked as it draws, so a theme change shows at once. */
function follow(o: THREE.Object3D, mat: THREE.LineDashedMaterial | THREE.MeshBasicMaterial) {
  o.onBeforeRender = () => mat.color.copy(COLOR[currentTheme()]);
}

export class MeasureOverlay {
  readonly group = new THREE.Group();
  private line: THREE.Line | null = null;
  private dots: THREE.Mesh[] = [];

  set(m: { a: V3; b: V3 } | null, scale: number) {
    this.clear();
    if (!m) return;
    const a = new THREE.Vector3(...m.a);
    const b = new THREE.Vector3(...m.b);
    const mat = new THREE.LineDashedMaterial({ color: COLOR[currentTheme()], dashSize: scale * 0.012, gapSize: scale * 0.008, depthTest: false, transparent: true });
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat);
    this.line.computeLineDistances();
    this.line.renderOrder = 20;
    follow(this.line, mat);
    this.group.add(this.line);
    const r = Math.max(scale * 0.004, 0.15);
    for (const p of [a, b]) {
      const dotMat = new THREE.MeshBasicMaterial({ color: COLOR[currentTheme()], depthTest: false, transparent: true });
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), dotMat);
      follow(dot, dotMat);
      dot.position.copy(p);
      dot.renderOrder = 21;
      this.dots.push(dot);
      this.group.add(dot);
    }
  }

  clear() {
    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      (this.line.material as THREE.Material).dispose();
      this.line = null;
    }
    for (const d of this.dots) {
      this.group.remove(d);
      d.geometry.dispose();
      (d.material as THREE.Material).dispose();
    }
    this.dots = [];
  }
}
