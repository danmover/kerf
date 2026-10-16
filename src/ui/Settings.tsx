// Settings: Claude connection, display preferences, local data and about.

import { useEffect, useRef, useState } from "react";
import { closeSettings, confirmDialog, go, openSettings, toast, useUi, type LegalDoc, type SettingsTab } from "../app/ui";
import { useSettings, updateSettings, resetSettings, clearSettingsStorage, MODELS, KEEP_WARM_MINUTES, MIN_STEPS, MAX_STEPS, type Effort, type ThemePref } from "../app/settings";
import { setTheme } from "../app/theme";
import { clearAllData, exportAllProjects, importProject, openProject, useProject } from "../app/project";
import { forgetApiKey, isRemembered, keyHint } from "../persist/vault";
import { storageEstimate } from "../persist/db";
import { resetChat } from "../ai/chat";
import { KeyForm } from "../screens/Onboarding";
import { useApiKey } from "./ChatPanel";
import { Modal, Segmented, Toggle } from "./common";
import { Icon } from "./icons";
import { LogoMark } from "./Logo";
import { VoiceSettings } from "./voice/VoiceSettings";
import { AgentSettings } from "./agents/AgentSettings";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "Claude", icon: <Icon.Sparkle size={14} /> },
  { id: "voice", label: "Voice", icon: <Icon.Mic size={14} /> },
  { id: "app", label: "Display", icon: <Icon.Eye size={14} /> },
  { id: "data", label: "Data", icon: <Icon.Layers size={14} /> },
  { id: "about", label: "About", icon: <Icon.Info size={14} /> },
];

export function SettingsModal() {
  const tab = useUi((s) => s.settingsOpen);
  // keep the last tab on screen while the modal animates out
  const last = useRef<SettingsTab>("ai");
  if (tab) last.current = tab;
  const shown = tab ?? last.current;
  return (
    <Modal open={!!tab} onClose={closeSettings} title="Settings" icon={<Icon.Settings size={16} />} width={800}>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} className={shown === t.id ? "active" : ""} onClick={() => openSettings(t.id)}>
              <span className="row" style={{ gap: 8 }}>
                {t.icon} {t.label}
              </span>
            </button>
          ))}
        </nav>
        <div className="modal-body" style={{ maxHeight: "min(72vh, 720px)" }}>
          {shown === "ai" && <AiSettings />}
          {shown === "voice" && <VoiceSettings />}
          {shown === "app" && <AppSettings />}
          {shown === "data" && <DataSettings />}
          {shown === "about" && <About />}
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div className="section-label" style={{ marginTop: 0 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({ t, d, children }: { t: string; d?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="grow">
        <div className="t">{t}</div>
        {d && <div className="d">{d}</div>}
      </div>
      {children}
    </div>
  );
}

const EFFORTS: { value: Effort; label: string; d: string }[] = [
  { value: "low", label: "low", d: "Quick answers and small edits. Cheapest." },
  { value: "medium", label: "med", d: "Balanced speed and care." },
  { value: "high", label: "high", d: "Careful modelling. Recommended for most work." },
  { value: "xhigh", label: "xhigh", d: "Extra checking for large revisions." },
  { value: "max", label: "max", d: "The most thorough. Slowest and most expensive." },
];

function AiSettings() {
  const key = useApiKey();
  const s = useSettings();
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setReplacing(false), [key]);
  const effort = EFFORTS.find((e) => e.value === s.effort)!;
  const designLabel = MODELS.find((m) => m.id === s.model)?.label ?? s.model;
  return (
    <>
      <Section title="API key">
        {key && !replacing ? (
          <div className="setting" style={{ alignItems: "center" }}>
            <span className="dot pass" />
            <div className="grow">
              <div className="t">
                Connected <span className="mono dim">{keyHint()}</span>
              </div>
              <div className="d">{isRemembered() ? "Remembered on this device, encrypted with a browser key that cannot be exported." : "Kept in memory only. You will be asked again after closing this tab."}</div>
            </div>
            <button className="btn" onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (await confirmDialog({ title: "Forget the API key?", body: "Kerf removes the key from memory and from this device. Chat stops working until you add a key again. Your designs are not affected.", confirm: "Forget key", danger: true })) {
                  await forgetApiKey();
                  toast({ kind: "success", title: "API key forgotten" });
                }
              }}
            >
              Forget
            </button>
          </div>
        ) : (
          <>
            <KeyForm onSaved={() => toast({ kind: "success", title: "Claude connected", detail: "You can chat with Claude in the right panel of any project." })} compact={!!key} />
            {replacing && (
              <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setReplacing(false)}>
                Keep the current key
              </button>
            )}
          </>
        )}
      </Section>

      <Section title="Model for design work">
        <div role="radiogroup" aria-label="Model" style={{ display: "grid", gap: 6 }}>
          {MODELS.map((m) => (
            <button key={m.id} role="radio" aria-checked={s.model === m.id} className={`template-opt ${s.model === m.id ? "active" : ""}`} onClick={() => updateSettings({ model: m.id })}>
              <div>
                <div style={{ fontWeight: 500 }}>{m.label}</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  {m.note}
                </div>
              </div>
              <span className="mono dim" style={{ fontSize: 11 }}>
                {m.id}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Cost">
        <Row
          t="Use the cheapest model that can do each turn"
          d={
            <>
              Quick questions, thanks and look-ups (a dimension, a material, which checks fail) go to Claude Haiku 5.5, about 40 times cheaper per token, whenever that costs less overall. Anything that changes the design, the brief or the plan, any engineering judgment, the self-review and parallel agents stay on {designLabel}. If Haiku reaches for a change, Kerf hands the turn to {designLabel} before anything runs, and any quick answer can be asked again on {designLabel}.
            </>
          }
        >
          <Toggle on={s.routeQuick} onChange={(v) => updateSettings({ routeQuick: v })} label="Use the cheapest model that can do each turn" />
        </Row>
        <Row
          t="Keep the conversation cached while you look"
          d={
            <>
              Claude reads the conversation back from a cache that forgets it 5 minutes after the last request. While you look at the design, Kerf refreshes it for a small fraction of what sending it again costs, so your next message is cheaper. Refreshing pauses while Kerf is hidden, and stops after this long without you typing, using the view or sending a message, or once more refreshes would cost more than sending the conversation again. After a quick answer from Haiku, {designLabel}'s cache is refreshed once either way, as answering on {designLabel} would have done.
            </>
          }
        >
          <Segmented
            id="keep-warm"
            value={String(s.keepWarm)}
            options={KEEP_WARM_MINUTES.map((m) => ({ value: String(m), label: m === 0 ? "Off" : m < 60 ? `${m} min` : `${m / 60} h` }))}
            onChange={(v) => updateSettings({ keepWarm: Number(v) })}
          />
        </Row>
        <Row t="Show cost per reply" d="A line under each reply with the model that answered, what the turn cost and what Kerf saved. Click it for the breakdown.">
          <Toggle on={s.showCost} onChange={(v) => updateSettings({ showCost: v })} label="Show cost per reply" />
        </Row>
      </Section>

      <Section title="Behaviour">
        <Row t="Effort" d={effort.d}>
          <Segmented id="effort" value={s.effort} options={EFFORTS.map((e) => ({ value: e.value, label: e.label }))} onChange={(v) => updateSettings({ effort: v })} />
        </Row>
        <Row t="Show Claude's reasoning" d="Shows a summary of Claude's thinking above each answer, collapsed by default.">
          <Toggle on={s.showThinking} onChange={(v) => updateSettings({ showThinking: v })} label="Show Claude's reasoning" />
        </Row>
        <Row t="Steps per message" d="The most rounds of tool calls (edits, checks, views, part lookups) Claude can make for one message before it stops and reports. Designing a whole machine takes about 20 to 40; each step costs tokens.">
          <div className="row" style={{ gap: 8, minWidth: 170 }}>
            <input type="range" min={MIN_STEPS} max={MAX_STEPS} step={1} value={s.maxSteps} onChange={(e) => updateSettings({ maxSteps: Number(e.target.value) })} aria-label="Steps per message" style={{ flex: 1 }} />
            <span className="mono" style={{ width: 22, textAlign: "right" }}>
              {s.maxSteps}
            </span>
          </div>
        </Row>
        <Row
          t="Search the web for parts"
          d="When the parts catalog has nothing suitable, Claude can search the web and read product pages to find a real part with a price and a link. Anthropic runs the searches and bills them to your API key ($10 per 1,000 searches at the time of writing, plus the tokens the pages use). Results come from the open web, so check a part before you buy it."
        >
          <Toggle on={s.webSearch} onChange={(v) => updateSettings({ webSearch: v, webNotice: false })} label="Search the web for parts" />
        </Row>
      </Section>

      <Section title="Self-review">
        <Row t="Review Claude's work" d="Before Claude reports back, a separate reviewer looks at the design from every side, measures its details (sharp edges, hole lead-ins, inside corners, walls, overhangs) and checks it against what you asked for. Claude fixes what it finds. Each review is one more request, with images.">
          <Segmented
            id="self-review"
            value={s.selfReview}
            options={[
              { value: "off", label: "Off" },
              { value: "auto", label: "Big changes" },
              { value: "always", label: "Every change" },
            ]}
            onChange={(v) => updateSettings({ selfReview: v })}
          />
        </Row>
        <Row t="Review rounds per reply" d="The first review plus re-checks after Claude fixes findings.">
          <Segmented id="review-rounds" value={String(s.reviewRounds)} options={["1", "2", "3"].map((v) => ({ value: v, label: v }))} onChange={(v) => updateSettings({ reviewRounds: Number(v) })} />
        </Row>
      </Section>
      <AgentSettings />
      <div className="help">Usage is billed to your Anthropic account at its normal API rates. Requests go straight from this browser to api.anthropic.com.</div>
    </>
  );
}

const THEMES: { value: ThemePref; label: string; d: string }[] = [
  { value: "dark", label: "Dark", d: "Kerf's default: a dark workspace that keeps the model the brightest thing on screen." },
  { value: "light", label: "Light", d: "Light panels and a pale backdrop behind the model, for bright rooms and printing screenshots." },
  { value: "system", label: "Match device", d: "Follows your device's light or dark setting, and changes when it does." },
];

function AppSettings() {
  const s = useSettings();
  const theme = THEMES.find((t) => t.value === s.theme) ?? THEMES[0];
  return (
    <>
      <Section title="Appearance">
        <Row t="Theme" d={theme.d}>
          <Segmented id="theme" value={s.theme} options={THEMES.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => setTheme(v)} />
        </Row>
      </Section>
      <Section title="Viewport">
        <Row t="Ground grid" d="A millimetre grid under the model.">
          <Toggle on={s.grid} onChange={(v) => updateSettings({ grid: v })} label="Ground grid" />
        </Row>
        <Row t="Edge lines" d="Outlines the sharp edges of every part.">
          <Toggle on={s.edges} onChange={(v) => updateSettings({ edges: v })} label="Edge lines" />
        </Row>
      </Section>
      <Section title="Motion">
        <Row t="Reduce motion" d="Turns off interface animations and the build-in reveal of new parts. Mechanism playback still works when you press play.">
          <Toggle on={s.reduceMotion} onChange={(v) => updateSettings({ reduceMotion: v })} label="Reduce motion" />
        </Row>
      </Section>
      <button className="btn" onClick={() => (resetSettings(), toast({ kind: "success", title: "Preferences reset" }))}>
        <Icon.Refresh size={14} /> Reset preferences
      </button>
    </>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function DataSettings() {
  const projects = useProject((s) => s.projects);
  const save = useProject((s) => s.save);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void storageEstimate().then(setEst);
    navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null));
  }, [projects.length]);

  const requestPersist = async () => {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    setPersisted(!!ok);
    toast(ok ? { kind: "success", title: "Storage is now persistent", detail: "The browser will not clear Kerf's data to free space." } : { kind: "warn", title: "The browser declined", detail: "Some browsers only allow this for installed or frequently used sites. Keep a backup to be safe." });
  };

  const clearAll = async () => {
    const ok = await confirmDialog({
      title: "Clear all Kerf data?",
      body: `This deletes ${projects.length} project${projects.length === 1 ? "" : "s"}, their history and chats, your saved API key and your preferences from this browser. It cannot be undone. Download a backup first if you may need anything.`,
      confirm: "Delete everything",
      danger: true,
    });
    if (!ok) return;
    resetChat();
    await forgetApiKey();
    await clearAllData();
    clearSettingsStorage();
    location.reload();
  };

  return (
    <>
      <Section title="Storage">
        <Row
          t={save === "memory" ? "Not saving" : "Saved in this browser"}
          d={save === "memory" ? "This browser is blocking storage (private mode or a site setting), so projects last only until the tab closes." : "Projects, history and chats are kept in this browser only. Nothing is uploaded. Another browser or device will not see them unless you move a backup file."}
        >
          <span className={`chip ${save === "memory" ? "warn" : "pass"}`}>{save === "memory" ? "memory only" : `${projects.length} project${projects.length === 1 ? "" : "s"}`}</span>
        </Row>
        {est && est.quota > 0 && (
          <Row t="Space used" d={`${fmtBytes(est.usage)} of the ${fmtBytes(est.quota)} this browser allows for Kerf.`}>
            <div style={{ width: 120, height: 6, borderRadius: 3, background: "var(--bg-4)", overflow: "hidden" }} aria-hidden="true">
              <div style={{ width: `${Math.max(2, Math.min(100, (est.usage / est.quota) * 100))}%`, height: "100%", background: "var(--accent)" }} />
            </div>
          </Row>
        )}
        {persisted !== null && save !== "memory" && (
          <Row t="Protect from automatic clean-up" d={persisted ? "The browser has agreed not to clear Kerf's data when the disk is low." : "Browsers may clear site data when disk space runs low. Ask the browser to keep it."}>
            {persisted ? (
              <span className="chip pass">protected</span>
            ) : (
              <button className="btn sm" onClick={() => void requestPersist()}>
                Keep data
              </button>
            )}
          </Row>
        )}
      </Section>
      <Section title="Backup">
        <Row t="Download a backup" d="One .kerfbackup file with every project and its version history. Chats are not included.">
          <button className="btn" onClick={() => void exportAllProjects()} disabled={!projects.length}>
            <Icon.Download size={14} /> Download
          </button>
        </Row>
        <Row t="Import" d="Adds projects from a .kerfbackup, .kerfproj or .kerf file. Existing projects are kept.">
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Icon.Upload size={14} /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".kerf,.kerfproj,.kerfbackup,.json,.txt"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const p = await importProject(f);
              if (p) {
                closeSettings();
                await openProject(p.id);
              }
            }}
          />
        </Row>
      </Section>
      <Section title="Danger zone">
        <Row t="Clear all data" d="Deletes every project, chat, your saved API key and preferences from this browser, then restarts Kerf.">
          <button className="btn danger" onClick={() => void clearAll()}>
            <Icon.Trash size={14} /> Clear all
          </button>
        </Row>
      </Section>
    </>
  );
}

function About() {
  const screen = useUi((s) => s.screen);
  const back = screen.name === "workspace" ? "workspace" : screen.name === "onboarding" ? "onboarding" : "home";
  const open = (doc: LegalDoc) => {
    closeSettings();
    go({ name: "legal", doc, back });
  };
  return (
    <>
      <div className="row" style={{ gap: 12, marginBottom: 14 }}>
        <LogoMark size={36} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Kerf {__APP_VERSION__}</div>
          <div className="muted">AI-directed mechanical CAD · prototype</div>
        </div>
      </div>
      <Section title="How Kerf handles your data">
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 12.5 }}>
          <li>There is no Kerf server or account. Designs, history and chats stay in this browser.</li>
          <li>Chat messages, the design file and requested screenshots go directly to api.anthropic.com with your key, only when you send a message.</li>
          <li>Voice input is turned into text on this device when the browser can. Otherwise the browser's own speech service hears your audio, only if you allow it. Kerf never records or uploads audio.</li>
          <li>Your key is kept in memory unless you choose to remember it, in which case it is encrypted with a browser key that cannot be exported.</li>
          <li>A strict Content Security Policy allows network connections only to Kerf itself and api.anthropic.com. AI output is never rendered as HTML.</li>
          <li>When web search is on, Anthropic's servers do the searching and page reading; this browser still talks only to api.anthropic.com. Links to sources open in a new tab only when you click them.</li>
          <li>Imported files are size-limited and validated before use.</li>
        </ul>
      </Section>
      <Section title="Legal (drafts)">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <button className="btn sm" onClick={() => open("terms")}>
            Terms of Service
          </button>
          <button className="btn sm" onClick={() => open("privacy")}>
            Privacy notice
          </button>
          <button className="btn sm" onClick={() => open("acceptable-use")}>
            Acceptable use
          </button>
          <button className="btn sm" onClick={() => open("licenses")}>
            Open-source licences
          </button>
        </div>
      </Section>
      <Section title="Help">
        <button className="btn sm" onClick={() => (closeSettings(), useUi.setState({ shortcutsOpen: true }))}>
          <Icon.Keyboard size={14} /> Keyboard shortcuts
        </button>
      </Section>
    </>
  );
}
