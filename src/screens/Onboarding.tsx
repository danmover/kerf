// First run: accept the draft terms, optionally add an API key, say what you
// make and what you can make it with, then pick a start.

import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { updateSettings, TERMS_VERSION, useSettings } from "../app/settings";
import { go } from "../app/ui";
import { createProject, openProject } from "../app/project";
import { setApiKey, validateKeyFormat } from "../persist/vault";
import { testKey } from "../ai/chat";
import { AUDIENCES, TEMPLATES, audienceById, templateById } from "../demos/templates";
import { LogoMark } from "../ui/Logo";
import { Icon } from "../ui/icons";
import { Toggle } from "../ui/common";

export function Onboarding() {
  const settings = useSettings();
  const returning = settings.onboarded && settings.termsAccepted !== TERMS_VERSION;
  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const total = returning ? 1 : 4;

  const finishTerms = () => {
    updateSettings({ termsAccepted: TERMS_VERSION });
    if (returning) go({ name: "home" });
    else setStep(1);
  };

  return (
    <div className="screen">
      <div className="backdrop-glow" />
      <div className="backdrop-grid" />
      <div className="onboard">
        <motion.div className="onboard-card" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 28 }}>
          <div className="steps">
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={i <= step ? "on" : ""} />
            ))}
          </div>
            {step === 0 && (
              <motion.div key="s0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <div className="row" style={{ gap: 12 }}>
                  <LogoMark size={40} />
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{returning ? "Our terms changed" : "Welcome to Kerf"}</div>
                    <div className="muted">Mechanical CAD where the AI models and you direct.</div>
                  </div>
                </div>
                {!returning && (
                  <div className="feature-list">
                    <Feature icon={<Icon.Sparkle size={15} />} title="Describe, don't draw" text="Tell Claude what to build, the dimensions that matter and what must stay fixed. It writes the design and revises it." />
                    <Feature icon={<Icon.Shield size={15} />} title="Checked on every change" text="Exact solids from OpenCASCADE, checked for requirements, interference, screw access, gear meshing and motion." />
                    <Feature icon={<Icon.Code size={15} />} title="One editable design file" text="Chat, sliders and code all edit the same source, with full version history and undo." />
                  </div>
                )}
                <div className="notice warn" style={{ margin: "14px 0" }}>
                  <div className="t">Prototype terms (draft)</div>
                  <div className="d">The Terms of Service and Privacy notice are drafts that have not had legal review. Kerf is a prototype: check designs yourself and test parts before relying on them.</div>
                </div>
                <label className="check">
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                  <span>
                    I have read and accept the draft{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "terms", back: "onboarding" }))}>
                      Terms of Service
                    </a>
                    ,{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "privacy", back: "onboarding" }))}>
                      Privacy notice
                    </a>{" "}
                    and{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "acceptable-use", back: "onboarding" }))}>
                      Acceptable use policy
                    </a>
                    .
                  </span>
                </label>
                <div className="row" style={{ marginTop: 22, justifyContent: "flex-end" }}>
                  <button className="btn primary lg" disabled={!accepted} onClick={finishTerms}>
                    Continue <Icon.Chevron size={14} />
                  </button>
                </div>
              </motion.div>
            )}
            {step === 1 && <KeyStep key="s1" onDone={() => setStep(2)} />}
            {step === 2 && <AboutStep key="s2" onDone={() => setStep(3)} />}
            {step === 3 && <StartStep key="s3" />}
        </motion.div>
      </div>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="feature">
      <div className="ic">{icon}</div>
      <div>
        <div className="t">{title}</div>
        <div className="d">{text}</div>
      </div>
    </div>
  );
}

export function KeyForm({ onSaved, compact }: { onSaved: () => void; compact?: boolean }) {
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string; ok: string }>({ busy: false, error: "", ok: "" });
  const save = async () => {
    const err = validateKeyFormat(key);
    if (err) return setState({ busy: false, error: err, ok: "" });
    setState({ busy: true, error: "", ok: "" });
    const r = await testKey(key.trim());
    if (!r.ok) return setState({ busy: false, error: r.message, ok: "" });
    try {
      await setApiKey(key, remember);
      setKey("");
      setState({ busy: false, error: "", ok: "Connected." });
      onSaved();
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e), ok: "" });
    }
  };
  return (
    <div>
      <label className="field-label" htmlFor="api-key">
        Claude API key
      </label>
      <div className="row">
        <input
          id="api-key"
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-api03-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
        <button className="btn primary" disabled={!key.trim() || state.busy} onClick={() => void save()}>
          {state.busy ? <div className="spinner" /> : <Icon.Check size={14} />} {state.busy ? "Checking" : "Test & save"}
        </button>
      </div>
      {state.error && <div className="err-text">{state.error}</div>}
      <div className="setting" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <div className="grow">
          <div className="t">Remember on this device</div>
          <div className="d">Off: the key is kept in memory and forgotten when you close the tab. On: it is encrypted with a browser key that cannot be exported and stored on this device. Do not turn this on for a shared computer.</div>
        </div>
        <Toggle on={remember} onChange={setRemember} label="Remember the API key on this device" />
      </div>
      {!compact && (
        <div className="help">
          Create a key in the{" "}
          <a href="https://platform.claude.com/" target="_blank" rel="noopener noreferrer">
            Claude Console
          </a>{" "}
          under Settings → API keys. Usage is billed to your Anthropic account. The key goes only to api.anthropic.com, straight from this browser.
        </div>
      )}
    </div>
  );
}

function KeyStep({ onDone }: { onDone: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
      <div style={{ fontSize: 20, fontWeight: 600 }}>Connect Claude</div>
      <div className="muted" style={{ margin: "4px 0 18px" }}>
        Chatting with Claude uses your own API key. You can skip this and add it later in Settings; the editor, checks and exports work without it.
      </div>
      <KeyForm onSaved={onDone} />
      <div className="row" style={{ marginTop: 22, justifyContent: "space-between" }}>
        <span className="dim" style={{ fontSize: 12 }}>
          <Icon.Shield size={12} /> Sent only to Anthropic, straight from this device.
        </span>
        <button className="btn ghost" onClick={onDone}>
          Skip for now
        </button>
      </div>
    </motion.div>
  );
}

/** The tools the about step offers, as the manufacturing processes they stand for (see mfg/profiles). */
const TOOLS: { process: string; label: string }[] = [
  { process: "fdm", label: "3D printer" },
  { process: "sla", label: "Resin printer" },
  { process: "laser_cut", label: "Laser cutter" },
  { process: "cnc_mill", label: "CNC mill or router" },
  { process: "cnc_lathe", label: "Lathe" },
  { process: "sheet_metal", label: "Sheet metal folder" },
  { process: "vacuum_cast", label: "Resin casting" },
];

function AboutStep({ onDone }: { onDone: () => void }) {
  const settings = useSettings();
  const [audience, setAudience] = useState(settings.audience);
  const [own, setOwn] = useState(() => new Set(Object.entries(settings.processAccess).filter(([, a]) => a === "own").map(([k]) => k)));
  const flip = (id: string) =>
    setOwn((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const save = () => {
    const access = { ...settings.processAccess };
    for (const t of TOOLS) {
      if (own.has(t.process)) access[t.process] = "own";
      else if (access[t.process] === "own") delete access[t.process];
    }
    updateSettings({ audience, processAccess: access });
    onDone();
  };
  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
      <div style={{ fontSize: 20, fontWeight: 600 }}>What will you make?</div>
      <div className="muted" style={{ margin: "4px 0 14px" }}>
        Kerf puts the examples that suit you first. You can change this later.
      </div>
      <div className="about-pick" role="radiogroup" aria-label="What you will make">
        {AUDIENCES.map((a) => (
          <button key={a.id} role="radio" aria-checked={audience === a.id} className={`about-opt ${audience === a.id ? "active" : ""}`} onClick={() => setAudience(audience === a.id ? "" : a.id)}>
            <span className="t">{a.label}</span>
            <span className="d">{a.detail}</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 20 }}>What can you make parts with?</div>
      <div className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
        Claude designs for the tools you have, and the checks test parts against them. Anything else can be ordered from a service. Settings → Making has the full list, your machines' sizes and parts you already have.
      </div>
      <div className="about-tools">
        {TOOLS.map((t) => (
          <button key={t.process} className={`about-tool ${own.has(t.process) ? "active" : ""}`} aria-pressed={own.has(t.process)} onClick={() => flip(t.process)}>
            {own.has(t.process) ? <Icon.Check size={12} /> : <Icon.Plus size={12} />} {t.label}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 22, justifyContent: "space-between" }}>
        <button className="btn ghost" onClick={onDone}>
          Skip
        </button>
        <button className="btn primary lg" onClick={save}>
          Continue <Icon.Chevron size={14} />
        </button>
      </div>
    </motion.div>
  );
}

function StartStep() {
  const audience = audienceById(useSettings((s) => s.audience));
  // the examples that suit them, recommended first, then the rest of their first two kinds
  const picks = useMemo(() => {
    const order = audience?.order ?? ["parts", "mechanisms", "machines", "processes"];
    const rec = audience?.recommended ?? "enclosure";
    const rest = TEMPLATES.filter((t) => t.id !== "blank" && t.id !== rec && order.slice(0, 2).includes(t.category ?? "parts")).sort((a, b) => order.indexOf(a.category ?? "parts") - order.indexOf(b.category ?? "parts"));
    return [templateById(rec)!, ...rest].filter(Boolean).slice(0, 5);
  }, [audience]);
  const [pick, setPick] = useState(picks[0]?.id ?? "enclosure");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    updateSettings({ onboarded: true });
    const p = await createProject(pick);
    await openProject(p.id);
  };
  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
      <div style={{ fontSize: 20, fontWeight: 600 }}>Pick a starting point</div>
      <div className="muted" style={{ margin: "4px 0 16px" }}>
        Each example is a complete, checked design you can change by chat. Try the suggested requests in the chat panel. Or go to your projects and describe your own.
      </div>
      <div className="template-pick">
        {picks.map((t, i) => (
          <button key={t.id} className={`template-opt ${pick === t.id ? "active" : ""}`} onClick={() => setPick(t.id)}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {t.name} {i === 0 && <span className="chip accent" style={{ marginLeft: 6 }}>recommended</span>}
              </div>
              <div className="dim" style={{ fontSize: 12.5, marginTop: 2 }}>
                {t.tagline}
              </div>
            </div>
            <span className="chip">{t.shows?.[0] ?? t.stats}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 22, justifyContent: "space-between" }}>
        <button
          className="btn ghost"
          onClick={() => {
            updateSettings({ onboarded: true });
            go({ name: "home" });
          }}
        >
          Describe my own
        </button>
        <button className="btn primary lg" disabled={busy} onClick={() => void start()}>
          {busy ? <div className="spinner" /> : null} Open design <Icon.Chevron size={14} />
        </button>
      </div>
    </motion.div>
  );
}
