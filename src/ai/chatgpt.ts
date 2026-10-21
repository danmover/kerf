// The browser owns the design engine. An explicitly enabled, authenticated
// connection lets the hosted MCP endpoint relay tools to this one tab.
import { create } from "zustand";
import { api } from "../cloud/api";
import { useAccount } from "../cloud/account";
import { useProject } from "../app/project";
import { callTool, mcpTools } from "./claudeCode";
export const useChatGPT = create<{ connected: boolean; busy: boolean; error: string; endpoint: string }>(() => ({ connected: false, busy: false, error: "", endpoint: "" }));
let connection: { id: string; abort: AbortController; owner: string } | null = null;
const running = new Map<string, AbortController>();
type Job = { id: string; cancel?: boolean; params?: { name: string; arguments: unknown } };

async function run(job: Job, id: string, outer: AbortSignal) {
  if (job.cancel) { running.get(job.id)?.abort(); return; }
  if (!job.params || outer.aborted) return;
  const ac = new AbortController(); running.set(job.id, ac);
  const project = useProject.getState().current?.id;
  const off = useProject.subscribe(s => { if (s.current?.id !== project) ac.abort(); });
  const stop = () => ac.abort(); outer.addEventListener("abort", stop, { once: true });
  try {
    const result = await callTool(job.params, ac.signal, "ChatGPT");
    if (!outer.aborted) await api("POST", "/mcp/reply", { id, request: job.id, result }, { signal: outer });
  } finally { off(); running.delete(job.id); outer.removeEventListener("abort", stop); }
}
async function poll(id: string, signal: AbortSignal) {
  try {
    while (!signal.aborted) {
      const { jobs } = await api<{ jobs: Job[] }>("POST", "/mcp/poll", { id }, { signal });
      for (const job of jobs) void run(job, id, signal).catch(async e => {
        if (!signal.aborted) await api("POST", "/mcp/reply", { id, request: job.id, result: { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : "Kerf could not run the tool." }] } }, { signal }).catch(() => undefined);
      });
    }
  } catch (e) {
    if (!signal.aborted) { useChatGPT.setState({ error: e instanceof Error ? e.message : "The connection ended." }); await disconnectChatGPT(); }
  }
}
export async function connectChatGPT() {
  if (connection || useChatGPT.getState().busy) return;
  const acct = useAccount.getState(); const owner = acct.info?.user?.id;
  if (acct.status !== "signed-in" || !owner) { useChatGPT.setState({ error: "Sign in to a hosted Kerf account first." }); return; }
  useChatGPT.setState({ busy: true, error: "" });
  try {
    const info = await api<{ id: string; endpoint: string }>("POST", "/mcp/connect", { tools: mcpTools() });
    if (useAccount.getState().info?.user?.id !== owner) { await api("POST", "/mcp/disconnect", { id: info.id }).catch(() => undefined); return; }
    const abort = new AbortController(); connection = { id: info.id, abort, owner };
    useChatGPT.setState({ connected: true, endpoint: info.endpoint }); void poll(info.id, abort.signal);
  } catch (e) { useChatGPT.setState({ error: e instanceof Error ? e.message : "Could not connect." }); }
  finally { useChatGPT.setState({ busy: false }); }
}
export async function disconnectChatGPT() {
  const active = connection; connection = null;
  active?.abort.abort(); for (const ac of running.values()) ac.abort(); running.clear();
  useChatGPT.setState({ connected: false });
  if (active) await api("POST", "/mcp/disconnect", { id: active.id }).catch(() => undefined);
}
useAccount.subscribe(s => { if (connection && (s.status !== "signed-in" || s.info?.user?.id !== connection.owner)) void disconnectChatGPT(); });
if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
  const active = connection; if (!active) return;
  active.abort.abort(); for (const ac of running.values()) ac.abort();
  void fetch("/api/mcp/disconnect", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json", "x-kerf": "1" }, body: JSON.stringify({ id: active.id }) }).catch(() => undefined);
  connection = null; useChatGPT.setState({ connected: false });
});
