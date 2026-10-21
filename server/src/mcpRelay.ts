// Per-account, per-browser-session relay. Only a tab explicitly enabled by its
// signed-in owner can execute calls. No global active-design or shared queue.
import { randomBytes } from "node:crypto";
export const BRIDGE_TTL = 60_000;
const TOOL_TIMEOUT = 10 * 60_000;
export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
export type BridgeJob = { id: string; params?: { name: string; arguments: unknown }; cancel?: boolean };
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
interface Bridge { id: string; session: string; touched: number; tools: McpTool[]; jobs: BridgeJob[]; pending: Map<string, Pending>; wake?: () => void }
export const READ_TOOLS = new Set(["kerf_instructions", "get_design", "get_sketch", "run_checks", "catalog_lookup", "engineering_calc", "capture_view", "inspect_part", "view_drawing", "view_reference", "get_materials", "material_lookup", "get_processes"]);
export class McpRelay {
  private bridges = new Map<string, Bridge>();
  private find(user: string) {
    const b = this.bridges.get(user);
    if (b && b.touched + BRIDGE_TTL <= Date.now()) { this.disconnect(user, b.id); return undefined; }
    return b;
  }
  connect(user: string, session: string, tools: McpTool[]) {
    for (const key of this.bridges.keys()) this.find(key);
    if (this.find(user)) throw Error("Another Kerf tab is connected. Disconnect it or wait a minute after closing it.");
    const b: Bridge = { id: randomBytes(24).toString("base64url"), session, touched: Date.now(), tools, jobs: [], pending: new Map() };
    this.bridges.set(user, b); return b.id;
  }
  owns(user: string, session: string, id: string) { const b = this.find(user); return !!b && b.id === id && b.session === session; }
  status(user: string) { return !!this.find(user); }
  tools(user: string) {
    const b = this.find(user); if (!b) throw Error("Open Kerf, sign in, open a project, and enable ChatGPT in Settings → AI.");
    return b.tools;
  }
  async poll(user: string, id: string, signal: AbortSignal): Promise<BridgeJob[]> {
    const b = this.find(user); if (!b || b.id !== id) throw Error("This Kerf connection has ended.");
    if (b.wake) throw Error("A poll is already running for this connection.");
    b.touched = Date.now();
    if (!b.jobs.length && !signal.aborted) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); b.wake = undefined; resolve(); };
      const timer = setTimeout(done, 20_000); b.wake = done; signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    if (signal.aborted) return [];
    b.touched = Date.now(); return b.jobs.splice(0);
  }
  call(user: string, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const b = this.find(user); if (!b) return Promise.reject(Error("Kerf is not connected. Open its ChatGPT settings and connect this tab."));
    if (b.pending.size >= 8) return Promise.reject(Error("Kerf has too many calls waiting. Try again after they finish."));
    if (!b.tools.some(t => t.name === name)) return Promise.reject(Error("Unknown Kerf tool."));
    if (signal.aborted) return Promise.reject(Error("Cancelled."));
    const id = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const p = b.pending.get(id); if (!p) return;
        p.cleanup(); b.pending.delete(id); b.jobs = b.jobs.filter(j => j.id !== id);
        b.jobs.push({ id, cancel: true }); b.wake?.(); reject(Error("Kerf call cancelled or timed out."));
      };
      const timer = setTimeout(cancel, TOOL_TIMEOUT);
      b.pending.set(id, { resolve, reject, timer, cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); } });
      signal.addEventListener("abort", cancel, { once: true });
      b.jobs.push({ id, params: { name, arguments: args } }); b.wake?.();
    });
  }
  reply(user: string, id: string, request: string, value: unknown) {
    const b = this.find(user); if (!b || b.id !== id) return false;
    const p = b.pending.get(request); if (!p) return false;
    p.cleanup(); b.pending.delete(request); p.resolve(value); return true;
  }
  disconnect(user: string, id?: string) {
    const b = this.bridges.get(user); if (!b || (id && b.id !== id)) return;
    for (const p of b.pending.values()) { p.cleanup(); p.reject(Error("Kerf disconnected.")); }
    b.pending.clear(); b.wake?.(); this.bridges.delete(user);
  }
}
