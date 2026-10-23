import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../cloud/api";
import { useAccount } from "../cloud/account";
import { connectChatGPT, disconnectChatGPT, useChatGPT } from "../ai/chatgpt";
import { getOpenAIKey, setOpenAIKey, forgetOpenAIKey, openAIKeyRemembered, subscribeOpenAIKey } from "../persist/openaiVault";
import { updateSettings } from "../app/settings";
import { toast } from "../app/ui";

export function OpenAIKeySection() {
  const key = useSyncExternalStore(subscribeOpenAIKey, getOpenAIKey);
  const [value, setValue] = useState(""); const [remember, setRemember] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { await setOpenAIKey(value, remember); setValue(""); updateSettings({ model: "gpt-6.1-sol" }); toast({ kind: "success", title: "OpenAI connected" }); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the key."); } finally { setBusy(false); }
  };
  return <section style={{ marginBottom: 18 }}><div className="section-label">OpenAI API key</div>
    <div className="setting" style={{ display: "block" }}>
      <div className="d">Use OpenAI models in Kerf’s own chat, self-review and design agents. API usage is billed separately from your ChatGPT subscription. Requests go directly to api.openai.com.</div>
      {key && <div className="row" style={{ marginTop: 10, gap: 8 }}><span className="grow">Connected · …{key.slice(-4)} · {openAIKeyRemembered() ? "Remembered, encrypted on this device" : "This session only"}</span><button className="btn sm" onClick={() => void forgetOpenAIKey().catch(e => setError(String(e)))}>Forget key</button></div>}
      <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ marginTop: 10 }}>
        <label htmlFor="openai-key">{key ? "Replace OpenAI key" : "OpenAI API key"}</label>
        <input id="openai-key" type="password" autoComplete="off" spellCheck={false} className="input" style={{ width: "100%", marginTop: 6 }} value={value} onChange={e => setValue(e.target.value)} placeholder="sk-…" />
        <label className="row" style={{ gap: 8, marginTop: 10 }}><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Remember on this device, encrypted</label>
        {error && <div role="alert" style={{ marginTop: 8 }}>{error}</div>}
        <button className="btn primary sm" disabled={busy || !value.trim()} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Connect OpenAI"}</button>
      </form>
    </div></section>;
}
interface Status { configured: boolean; endpoint: string; grants: { id: string; scope: string; created_at: number }[] }
export function ChatGPTSection() {
  const signedIn = useAccount(s => s.status === "signed-in"); const bridge = useChatGPT(); const [info, setInfo] = useState<Status | null>(null); const [error, setError] = useState("");
  const load = () => api<Status>("GET", "/mcp/status").then(setInfo).catch(e => setError(e instanceof Error ? e.message : "Could not load connection settings."));
  useEffect(() => { if (signedIn) void load(); else setInfo(null); }, [signedIn, bridge.connected]);
  const revoke = async (id: string) => { try { await disconnectChatGPT(); await api("DELETE", `/mcp/grants/${id}`); await load(); } catch (e) { setError(String(e)); } };
  return <section style={{ marginBottom: 18 }}><div className="section-label">ChatGPT MCP connection</div><div className="setting" style={{ display: "block" }}>
    <div className="t">Design in Kerf from ChatGPT</div>
    <div className="d">ChatGPT can inspect, edit, capture views and check your open design using Kerf’s tools. Changes appear here and are saved in version history. Only the tab you explicitly connect is available.</div>
    {!signedIn ? <p className="d">Open your hosted Kerf app in a browser and sign in to connect ChatGPT. The desktop app’s local MCP connection remains available for local clients.</p> : !info?.configured ? <p className="d">The server operator needs to configure ChatGPT OAuth. See docs/CHATGPT.md in the Kerf repository.</p> : <>
      <p><button className="btn primary sm" disabled={bridge.busy} onClick={() => void (bridge.connected ? disconnectChatGPT() : connectChatGPT())}>{bridge.busy ? "Connecting…" : bridge.connected ? "Disconnect this tab" : "Connect this tab"}</button></p>
      <label htmlFor="chatgpt-endpoint">MCP server URL</label><input id="chatgpt-endpoint" className="input" style={{ width: "100%", marginTop: 6 }} readOnly value={info.endpoint} onFocus={e => e.target.select()} />
      <p className="d">Add this URL in ChatGPT’s developer settings using OAuth, then approve access to your Kerf account. Keep this tab open. Ask ChatGPT: “Read Kerf’s instructions, inspect my design and help me improve it.”</p>
      {bridge.connected && <p role="status">This tab is connected.</p>}
      {info.grants.map(g => <div className="row" key={g.id} style={{ gap: 8 }}><span className="grow">ChatGPT access · {new Date(g.created_at).toLocaleDateString()}</span><button className="btn ghost sm" onClick={() => void revoke(g.id)}>Revoke access</button></div>)}
    </>}
    {(error || bridge.error) && <p role="alert">{bridge.error || error}</p>}
  </div></section>;
}
