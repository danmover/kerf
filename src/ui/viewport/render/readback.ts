// Reading a rendered image back from the graphics card without stopping the page for it.
//
// gl.readPixels into memory waits until the card has finished everything asked of it so far, and the page is
// stopped for that long: a thumbnail of a large assembly, drawn a dozen times over for a clean image, held it up for
// a noticeable moment after every change. Read into a buffer on the card instead, the call returns at once, the
// card finishes in its own time, and the pixels are picked up when it says it has.

import type * as THREE from "three";

/**
 * Starts reading the `width` x `height` pixels (RGBA bytes, bottom row first) of the render target the renderer is
 * set to, into `into`. What has been drawn up to this call is what is read: the target can be drawn to again, or
 * disposed of, straight after. Resolves when the pixels are in `into`; rejects when the graphics context is lost.
 */
export function readPixelsLater(renderer: THREE.WebGLRenderer, width: number, height: number, into: Uint8Array): Promise<void> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, into.byteLength, gl.STREAM_READ);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
  // unbound again at once: while a buffer is bound here, an ordinary read elsewhere (a material swatch) fails
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return new Promise((resolve, reject) => {
    const done = (ok: boolean) => {
      if (ok) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, into);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
      gl.deleteBuffer(buf);
      if (sync) gl.deleteSync(sync);
      if (ok) resolve();
      else reject(new Error("The 3D view was reset while the image was being read"));
    };
    const probe = () => {
      if (!sync || gl.isContextLost()) return done(false);
      const state = gl.clientWaitSync(sync, 0, 0);
      if (state === gl.WAIT_FAILED) done(false);
      else if (state === gl.TIMEOUT_EXPIRED) setTimeout(probe, 4);
      else done(true);
    };
    setTimeout(probe, 0);
  });
}
