// Settings: Claude connection, display preferences, local data and about.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { closeSettings, confirmDialog, go, openSettings, toast, useUi, type LegalDoc, type SettingsTab } from "../app/ui";
import { useSettings, updateSettings, resetSettings, clearSettingsStorage, cleanOnHand, MODELS, KEEP_WARM_MINUTES, COMPACT_AT_TOKENS, MIN_STEPS, MAX_STEPS, SPEEDS, type Effort, type ThemePref } from "../app/settings";
import { setTheme } from "../app/theme";
import { clearAllData, exportAllProjects, importProject, openProject, useProject } from "../app/project";
import { forgetApiKey, getApiKey, isRemembered, keyHint, subscribeKey } from "../persist/vault";
import { storageEstimate } from "../persist/db";
import { priceFor } from "../agents/pricing";
import { resetChat } from "../ai/chat";
import { KeyForm } from "../screens/Onboarding";
import { Modal, Segmented, Toggle, timeAgo, useTick } from "./common";
import { Icon } from "./icons";
import { AUDIENCES } from "../demos/templates";
import { LogoMark } from "./Logo";
import { AccountKeySection, AccountSettings, CloudIcon, signOutForClear } from "./Account";
import { useAccount } from "../cloud/account";
import { VoiceSettings } from "./voice/VoiceSettings";
import { AgentSettings } from "./agents/AgentSettings";
import { BenchSection } from "./BenchSection";
import { LessonsSection } from "./LessonsSection";
import { ChatGPTSection, OpenAIKeySection } from "./ChatGPTSettings";
import { forgetOpenAIKey } from "../persist/openaiVault";
import { AccessEditor } from "./make/AccessEditor";
import { MachineEditor } from "./make/MachineEditor";
import "../styles/make.css";
import { desktop, graphicsCard, isSoftwareRenderer, type ClaudeCodeInfo, type DesktopInfo, type GraphicsBackend } from "../app/desktop";
import { MOUSE_SCHEMES, MOUSE_SCHEME_IDS, type MouseScheme } from "../app/mouse";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "AI", icon: <Icon.Sparkle size={14} /> },
  { id: "account", label: "Account", icon: <CloudIcon size={14} /> },
  { id: "voice", label: "Voice", icon: <Icon.Mic size={14} /> },
  { id: "app", label: "Display", icon: <Icon.Eye size={14} /> },
  { id: "making", label: "Making", icon: <Icon.Factory size={14} /> },
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
          {shown === "account" && <AccountSettings />}
          {shown === "voice" && <VoiceSettings />}
          {shown === "app" && <AppSettings />}
          {shown === "making" && <MakingSettings />}
          {shown === "data" && <DataSettings />}
          {shown === "about" && <About />}
        </div>
      </div>
    </Modal>
  );
}

function MakingSettings() {
  const labour = useSettings((s) => s.labourRate);
  const audience = useSettings((s) => s.audience);
  return (
    <>
      <Section title="What you make">
        <Row t="Mostly" d="Puts the examples and example briefs that suit you first on the projects page.">
          <select className="input" style={{ width: 240 }} value={audience} onChange={(e) => updateSettings({ audience: e.target.value })} aria-label="What you mostly make">
            <option value="">Not said</option>
            {AUDIENCES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Row>
      </Section>
      <Section title="Processes you can use">
        <div className="d" style={{ marginBottom: 10, color: "var(--text-3)", fontSize: 12.5 }}>
          Kerf recommends ways to make each part from these, for every design. A design's brief can list its own instead (workshop: and can_order:). Processes you have cost your time and material, with no shipping or waiting on a shop.
        </div>
        <AccessEditor settingsOnly />
      </Section>
      <Section title="Your machines">
        <div className="d" style={{ marginBottom: 10, color: "var(--text-3)", fontSize: 12.5 }}>
          Every part is checked against the machine you pick for its process: build size, nozzle and temperature, soluble supports, a mill's axes, travel, tools and spindle, a press's tonnage, a furnace's pour, a brake's length, a cutter's bed and source. Pick a preset or make your own; with none, Kerf assumes a typical shop. A part can name another with process: mfg.fdm(machine: "…").
        </div>
        <MachineEditor />
      </Section>
      <Section title="Parts you have">
        <div className="d" style={{ marginBottom: 10, color: "var(--text-3)", fontSize: 12.5 }}>
          One per line, the way you would say it: screws and nuts ("M3x10 socket", "M3x6-20 button stainless", "M3 nut", "M4 insert"), motors and boards by name or part number ("17HS4401", "Arduino Nano"). Claude prefers these when they fit, and the parts list marks them on hand and leaves them out of the cost.
        </div>
        <OnHandEditor />
      </Section>
      <Section title="Costs">
        <Row t="Your time" d="What an hour of your own work is worth, for parts made on your machines and for assembling a design.">
          <span className="mk-num">
            $
            <input type="number" min={0} max={500} step={1} value={labour} onChange={(e) => updateSettings({ labourRate: Math.min(500, Math.max(0, Number(e.target.value) || 0)) })} aria-label="Your hourly rate in dollars" />
            /h
          </span>
        </Row>
      </Section>
    </>
  );
}

function OnHandEditor() {
  const saved = useSettings((s) => s.onHand);
  const [text, setText] = useState(() => saved.join("\n"));
  // pick up changes made elsewhere (the parts list's "I have this") while not typing here
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(saved.join("\n"));
  }, [saved]);
  const save = () => updateSettings({ onHand: cleanOnHand(text.split("\n")) });
  return (
    <textarea
      className="mk-onhand"
      rows={6}
      value={text}
      placeholder={"M3x8-20 socket\nM3 nut\nM3 insert\n17HS4401\nArduino Nano"}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        save();
      }}
      aria-label="Parts you have, one per line"
      spellCheck={false}
      style={{ width: "100%", boxSizing: "border-box", fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }}
    />
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

/** The key kept in this browser: in memory, or encrypted on this device if remembered. */
function BrowserKey() {
  const key = useSyncExternalStore(subscribeKey, getApiKey);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setReplacing(false), [key]);
  return key && !replacing ? (
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
  );
}

/** A command to copy, on one line. */
function CopyLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: "stretch", marginTop: 6 }}>
      <code className="mono grow" style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-0)", fontSize: 11.5, color: "var(--text-2)", overflowX: "auto", whiteSpace: "nowrap" }}>
        {text}
      </code>
      <button
        className="btn sm"
        aria-label={label}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => toast({ kind: "success", title: "Copied" }),
            () => toast({ kind: "warn", title: "Could not copy", detail: "Select the text and copy it yourself." }),
          )
        }
      >
        Copy
      </button>
    </div>
  );
}

const REMOVE_KERF = "claude mcp remove kerf -s user";

/** Whether Claude Code has reached Kerf's tools since Kerf started, or was turned away. */
function ClaudeCodeStatus({ info }: { info: ClaudeCodeInfo }) {
  useTick(15000);
  const ok = info.lastConnect;
  const bad = info.lastRefused;
  const [dot, t, d] =
    bad && (!ok || bad.at > ok.at)
      ? [
          "fail",
          `A program was turned away ${timeAgo(bad.at)}`,
          bad.why === "no-token"
            ? "It sent no token. Remove the old connection and run the connect command below exactly as copied."
            : "Its token is old or mistyped. Remove the old connection and run the connect command below again.",
        ]
      : ok
        ? ["pass", `Connected ${timeAgo(ok.at)}`, `${ok.client} reached Kerf's tools.`]
        : ["", "Not connected yet", "Nothing has connected since Kerf started. Follow the steps below, then check with claude mcp list."];
  return (
    <div className="setting" aria-live="polite">
      <span className={`dot ${dot}`} />
      <div className="grow">
        <div className="t">{t}</div>
        <div className="d">{d}</div>
      </div>
    </div>
  );
}

/** The person's own Claude Code, on their Claude plan, working through Kerf's tools (desktop app only). */
function ClaudeCodeSection() {
  const cc = desktop()?.claudeCode;
  const [info, setInfo] = useState<ClaudeCodeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void cc?.info().then(setInfo);
  }, [cc]);
  // follow connections as they happen, so the status shows the moment Claude Code reaches Kerf
  const running = !!info?.running;
  useEffect(() => {
    if (!cc || !running) return;
    const t = setInterval(() => void cc.info().then((n) => setInfo((o) => (JSON.stringify(o) === JSON.stringify(n) ? o : n))), 3000);
    return () => clearInterval(t);
  }, [cc, running]);
  const act = async (f: () => Promise<ClaudeCodeInfo>) => {
    setBusy(true);
    try {
      setInfo(await f());
    } finally {
      setBusy(false);
    }
  };
  const newToken = async () => {
    if (await confirmDialog({ title: "Make a new token?", body: "Claude Code's saved connection to Kerf stops working until you remove it and run the new connect command.", confirm: "New token" })) await act(() => cc!.newToken());
  };
  if (!cc)
    return (
      <Section title="Claude Code">
        <Row t="Use your Claude plan" d="In the Kerf desktop app, your own Claude Code can design in Kerf on your Claude Pro or Max plan, without an API key." />
      </Section>
    );
  const add = info ? `claude mcp add --transport http --scope user kerf ${info.url} --header "Authorization: Bearer ${info.token}"` : "";
  return (
    <Section title="Claude Code">
      <Row
        t="Let Claude Code use Kerf"
        d="Your own Claude Code, signed in with your Claude account, reads and changes the open design with Kerf's tools while you watch it here. It runs on your Claude plan's usage, not an API key. Only programs on this computer that have the token below can connect. Kerf's own chat panel still uses the API key above."
      >
        <Toggle on={!!info?.enabled} onChange={(v) => void act(() => cc.setEnabled(v))} label="Let Claude Code use Kerf" />
      </Row>
      {info?.enabled && info.error && (
        <div className="setting">
          <span className="dot fail" />
          <div className="grow">
            <div className="t">Kerf could not start its tools for Claude Code</div>
            <div className="d">{info.error}</div>
          </div>
          <button className="btn sm" disabled={busy} onClick={() => void act(() => cc.setEnabled(true))}>
            Try again
          </button>
        </div>
      )}
      {info?.running && <ClaudeCodeStatus info={info} />}
      {info?.running && (
        <div className="setting" style={{ display: "block" }}>
          <div className="t">Connect Claude Code (once)</div>
          <div className="d">
            1. Install Claude Code and sign in by running <span className="mono">claude</span> once in a terminal.
          </div>
          <div className="d" style={{ marginTop: 10 }}>
            2. If Claude Code was connected to Kerf before, remove that connection. It's safe to run if it never was:
          </div>
          <CopyLine text={REMOVE_KERF} label="Copy the remove command" />
          <div className="d" style={{ marginTop: 10 }}>
            3. Connect. This saves the connection for every folder. Run it exactly as copied: Claude Code talks to Kerf directly, so it needs no mcp-remote or other bridge.
          </div>
          <CopyLine text={add} label="Copy the connect command" />
          <div className="d" style={{ marginTop: 10 }}>
            4. Check with <span className="mono">claude mcp list</span>. It should say <span className="mono">kerf: … Connected</span>, and the status above turns green. If it still lists an old kerf, run <span className="mono">claude mcp remove kerf -s local</span> in the folder you're in.
          </div>
          <div className="d" style={{ marginTop: 10 }}>
            To design, open a project here, start Claude Code with Kerf's tools allowed and ask it, for example "Design a wall bracket for a 30 mm tube in Kerf":
          </div>
          <CopyLine text="claude --allowedTools mcp__kerf" label="Copy the start command" />
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <span className="d grow">Keep Kerf open while Claude Code works. Changes land in the version history like any other.</span>
            <button className="btn ghost sm" disabled={busy} onClick={() => void newToken()}>
              New token
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

function AiSettings() {
  const s = useSettings();
  const effort = EFFORTS.find((e) => e.value === s.effort)!;
  const server = useAccount((a) => a.status !== "none" && a.status !== "checking");
  const viaAccount = useAccount((a) => a.status === "signed-in" && a.info?.claude?.source === "account");
  const designLabel = MODELS.find((m) => m.id === s.model)?.label ?? s.model;
  return (
    <>
      <Section title="API key">
        <AccountKeySection browserForm={<BrowserKey />} />
        {!server && <BrowserKey />}
      </Section>

      <ClaudeCodeSection />
      <OpenAIKeySection />
      <ChatGPTSection />

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

      {!s.model.startsWith("gpt-") && <Section title="Cost">
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
        <Row
          t="Summarise long chats at"
          d={
            <>
              Every step of a reply reads the whole conversation again, so a long chat costs more per step: on {designLabel}, about ${stepCost(s.model, s.compactAt)} a step at this size, read from the cache. Past it, Claude summarises the older turns (about ${stepCost(s.model, s.compactAt, true)} once) and Kerf keeps the newest fifth word for word, with every message you wrote, the plan and the design. A larger size keeps more of the conversation exactly; a smaller one makes each step cheaper.
            </>
          }
        >
          <Segmented
            id="compact-at"
            value={String(s.compactAt)}
            options={COMPACT_AT_TOKENS.map((n) => ({ value: String(n), label: `${n / 1000}K` }))}
            onChange={(v) => updateSettings({ compactAt: Number(v) })}
          />
        </Row>
        <Row t="Show cost per reply" d="A line under each reply with the model that answered, what the turn cost and what Kerf saved. Click it for the breakdown.">
          <Toggle on={s.showCost} onChange={(v) => updateSettings({ showCost: v })} label="Show cost per reply" />
        </Row>
      </Section>

      }
      <Section title="Behaviour">
        <Row t="Speed" d={`${SPEEDS.find((x) => x.value === s.speed)?.d ?? ""} Also beside Send in the chat.`}>
          <Segmented id="speed" value={s.speed} options={SPEEDS.map((x) => ({ value: x.value, label: x.label }))} onChange={(v) => updateSettings({ speed: v })} />
        </Row>
        <Row t="Effort" d={effort.d}>
          <Segmented id="effort" value={s.effort} options={EFFORTS.map((e) => ({ value: e.value, label: e.label }))} onChange={(v) => updateSettings({ effort: v })} />
        </Row>
        <Row t="Faster follow-up steps" d="Claude plans each reply at the effort above, then thinks at medium for the steps after it: reading the checks an edit returned, small fixes, the reply itself. Replies finish sooner and cost less, with slightly less careful thinking on those steps.">
          <Toggle on={s.fasterFollowUps} onChange={(v) => updateSettings({ fasterFollowUps: v })} label="Faster follow-up steps" />
        </Row>
        <Row t="Do plain commands at once" d="A plain command typed in the chat changes the design straight away, without asking Claude: no wait and no cost. For example “fillet 2”, “chamfer 1 top”, “shell 2”, “move 10 up”, “rotate 90”, “wall 3” (any parameter), “PETG”, “red”, “copy”, “delete”, “box 40x20x10”, and after right-clicking a spot, “hole M3” or “fillet 1” on the edge there. Anything more than a plain command goes to Claude as usual.">
          <Toggle on={s.quickCommands} onChange={(v) => updateSettings({ quickCommands: v })} label="Do plain commands at once" />
        </Row>
        <Row t="Quick small changes" d="A short request for one plain change (“make the wall 3 mm thicker”, “round these edges”, “move the lid up 5”) has Claude think briefly and skips the self-review, so it comes back in seconds. If it turns out to need more, Claude carries on as usual.">
          <Toggle on={s.fastChanges} onChange={(v) => updateSettings({ fastChanges: v })} label="Quick small changes" />
        </Row>
        <Row t="Slimmer prompt (trial)" d="Claude starts each chat without the reference for machines, simulations, analyses, drawings and imported STEP files, about 40% of what it rereads at every step, and reads a section when a design needs it. Steps start sooner and cost a little less; the bench below shows whether the designs are as good. Applies from your next chat.">
          <Toggle on={s.leanPrompt} onChange={(v) => updateSettings({ leanPrompt: v })} label="Slimmer prompt" />
        </Row>
        <Row t="Modelling tools" d="Tools beside the 3D view for modelling it yourself: boxes, cylinders, holes, fillets, chamfers, shells, move, turn, copy and delete. Then “Fix it up” or “Make it buildable” has Claude finish what you modelled. The pencil in the view's toolbar shows and hides them.">
          <Toggle on={s.advanced} onChange={(v) => updateSettings({ advanced: v })} label="Modelling tools" />
        </Row>
        <Row t="Show reasoning" d="Shows a summary of the assistant's thinking above each answer, collapsed by default.">
          <Toggle on={s.showThinking} onChange={(v) => updateSettings({ showThinking: v })} label="Show Claude's reasoning" />
        </Row>
        <Row t="Steps per message" d="The most rounds of tool calls (edits, checks, views, part lookups) Claude can make for one message before it stops and reports. Designing and reviewing a whole machine takes about 20 to 50; each step costs tokens.">
          <div className="row" style={{ gap: 8, minWidth: 170 }}>
            <input type="range" min={MIN_STEPS} max={MAX_STEPS} step={1} value={s.maxSteps} onChange={(e) => updateSettings({ maxSteps: Number(e.target.value) })} aria-label="Steps per message" style={{ flex: 1 }} />
            <span className="mono" style={{ width: 22, textAlign: "right" }}>
              {s.maxSteps}
            </span>
          </div>
        </Row>
        <Row
          t="Search the web for parts"
          d="When the catalog has nothing suitable, your selected provider can search the web for real parts. The provider bills searches and page content to your API account. Check product details before buying. Shared Claude keys use the catalog only."
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
      <LessonsSection />
      <BenchSection />
      <div className="help">{s.model.startsWith("gpt-") ? "Usage is billed to your OpenAI API account, separately from ChatGPT. Requests go directly from this device to api.openai.com. Cost figures are estimates; your provider's billing is authoritative." : viaAccount ? "Usage is billed to the Anthropic account that owns the key, at its normal API rates. Requests go from this browser to your Kerf server, which adds the key and passes them to api.anthropic.com." : "Usage is billed to your Anthropic account at its normal API rates. Requests go straight from this browser to api.anthropic.com."}</div>
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
      <Section title="Mouse and keys">
        <Row t="Mouse" d={MOUSE_SCHEMES[s.mouseScheme].d}>
          <Segmented id="mouse" value={s.mouseScheme} options={MOUSE_SCHEME_IDS.map((id) => ({ value: id, label: MOUSE_SCHEMES[id].label }))} onChange={(v) => updateSettings({ mouseScheme: v as MouseScheme })} />
        </Row>
        <Row t="Reverse wheel zoom" d="Rolling the wheel towards you zooms in instead of out.">
          <Toggle on={s.wheelReverse} onChange={(v) => updateSettings({ wheelReverse: v })} label="Reverse wheel zoom" />
        </Row>
        <Row t="Keyboard shortcuts" d={Object.keys(s.keys).length ? `You moved ${Object.keys(s.keys).length === 1 ? "one key" : `${Object.keys(s.keys).length} keys`}. The sheet puts any key, or all of them, back.` : "Move any single-key shortcut to the key you are used to, or take the standard view keys of SolidWorks or Onshape."}>
          <button className="btn" onClick={() => (closeSettings(), useUi.setState({ shortcutsOpen: true }))}>
            <Icon.Keyboard size={14} /> Change keys
          </button>
        </Row>
      </Section>
      <GraphicsSettings />
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

const BACKENDS: Record<GraphicsBackend, { label: string; d: string }> = {
  auto: { label: "Auto", d: "Chromium's choice, which is Direct3D 11 on Windows. The safest option." },
  d3d11: { label: "Direct3D 11", d: "The same as Auto on Windows." },
  vulkan: { label: "Vulkan", d: "Another route to the card, which may get the photoreal view started faster. Switch back if anything looks wrong." },
  gl: { label: "OpenGL", d: "An older route to the graphics card, for drivers that misbehave with the others." },
};

/** The graphics card in use, and in the desktop app, how Kerf talks to it. */
function GraphicsSettings() {
  const app = desktop();
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [card] = useState(graphicsCard);
  useEffect(() => {
    void app?.info().then(setInfo);
  }, [app]);
  const choose = async (b: GraphicsBackend) => {
    await app?.setGraphics(b);
    setInfo((i) => i && { ...i, graphics: b });
  };
  return (
    <Section title="Graphics">
      <Row
        t="Graphics card"
        d={
          isSoftwareRenderer(card)
            ? "Kerf is drawing 3D in software because it can't use the graphics card here (Remote Desktop, a missing or old driver, or a virtual machine). Updating the graphics driver usually fixes it."
            : app
              ? "The card Kerf draws with."
              : "The card this browser draws with. If it isn't your fastest one, the Kerf desktop app always uses the fast card."
        }
      >
        <span className={`chip mono${isSoftwareRenderer(card) || card === "No WebGL 2" ? " warn" : ""}`}>{card}</span>
      </Row>
      {info && info.backends.length > 1 && (
        <Row t="Graphics backend" d={BACKENDS[info.graphics].d}>
          <Segmented id="graphics-backend" value={info.graphics} options={info.backends.map((b) => ({ value: b, label: BACKENDS[b].label }))} onChange={(v) => void choose(v)} />
        </Row>
      )}
      {info && info.graphics !== info.running && (
        <Row t="Restart to switch" d={`Kerf is using ${BACKENDS[info.running].label} until it restarts. Your work is saved.`}>
          <button className="btn primary sm" onClick={() => void app?.relaunch()}>
            <Icon.Refresh size={13} /> Restart Kerf
          </button>
        </Row>
      )}
      {info && <Row t="Desktop app" d={`Kerf ${info.version} · Electron ${info.electron} · Chromium ${info.chrome}`} />}
    </Section>
  );
}

/** What one step reading a conversation of `tokens` from the cache costs on `model`, or the summary of all but its newest fifth (sent uncached, with a summary of about 4K tokens). */
function stepCost(model: string, tokens: number, summary = false) {
  const p = priceFor(model, tokens);
  const usd = summary ? (tokens * 0.8 * p.input + 4000 * p.output) / 1e6 : (tokens * p.cacheRead) / 1e6;
  return usd < 1 ? usd.toFixed(2) : usd.toFixed(1);
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
    await signOutForClear();
    resetChat();
    await forgetApiKey();
    await forgetOpenAIKey();
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
  const server = useAccount((a) => a.status !== "none" && a.status !== "checking");
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
          {server ? (
            <>
              <li>This Kerf is served by a Kerf server. Without an account, designs, history and chats stay in this browser.</li>
              <li>When you sign in, projects in your account, their history and chats are also stored on that server so they sync between devices. Your password is stored only as a salted hash.</li>
              <li>A Claude key saved to your account is encrypted on the server and never sent back to a browser. Chat then goes through the server, which adds the key.</li>
            </>
          ) : (
            <li>There is no Kerf server or account. Designs, history and chats stay in this browser.</li>
          )}
          <li>Chat messages, the design file and requested screenshots go to api.anthropic.com only when you send a message.</li>
          <li>Voice input is turned into text on this device when the browser can. Otherwise the browser's own speech service hears your audio, only if you allow it. Kerf never records or uploads audio.</li>
          <li>A key kept in this browser is held in memory unless you choose to remember it, in which case it is encrypted with a browser key that cannot be exported.</li>
          <li>A strict Content Security Policy allows network connections only to Kerf itself{server ? " (and its server)" : ""} and api.anthropic.com. AI output is never rendered as HTML.</li>
          <li>When web search is on, Anthropic's servers do the searching and page reading, not this browser. Links to sources open in a new tab only when you click them.</li>
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
