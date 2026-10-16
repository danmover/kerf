// three-gpu-pathtracer has no types for its internals; photoreal.ts owns one of them
declare module "three-gpu-pathtracer/src/uniforms/RenderTarget2DArray.js" {
  import type { RenderTargetOptions, WebGLArrayRenderTarget } from "three";
  export class RenderTarget2DArray extends WebGLArrayRenderTarget {
    constructor(width?: number, height?: number, options?: RenderTargetOptions);
  }
}
