/// <reference lib="webworker" />
// An app's simulated twin, off the UI thread: the design's firmware on the
// virtual chip in a scenario's world, run in real time. Plain arithmetic: no
// eval, no WebAssembly, no network.

import { serveTwin, type TwinIn } from "./twinServe";

const take = serveTwin((m) => (self as unknown as Worker).postMessage(m));
self.onmessage = (ev: MessageEvent<TwinIn>) => take(ev.data);
