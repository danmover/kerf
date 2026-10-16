// Settings → Voice: where speech is turned into text, language and sending.

import { useEffect, useState } from "react";
import { useSettings, updateSettings, type VoiceSend } from "../../app/settings";
import { go, closeSettings, useUi } from "../../app/ui";
import { checkOnDevice, downloadSpeechModel, useVoice, voiceLang } from "../../voice/voice";
import type { OnDevice } from "../../voice/recognizer";
import { providerName, serviceName } from "../../voice/text";
import { Segmented, Toggle } from "../common";
import { Icon } from "../icons";

const LANGS = ["en-US", "en-GB", "en-AU", "en-IN", "de-DE", "fr-FR", "es-ES", "es-MX", "it-IT", "pt-BR", "nl-NL", "sv-SE", "pl-PL", "ja-JP", "ko-KR", "zh-CN", "hi-IN"];

function languageName(tag: string) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function VoiceSettings() {
  const s = useSettings();
  const provider = useVoice((v) => v.provider);
  const downloading = useVoice((v) => v.phase === "downloading");
  const wanted = voiceLang();
  const [{ lang, status }, setState] = useState<{ lang: string; status: OnDevice | "none" | null }>({ lang: wanted, status: null });
  useEffect(() => {
    let live = true;
    setState({ lang: wanted, status: null });
    void checkOnDevice().then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [wanted, downloading]);

  const company = providerName(provider);
  const service = serviceName(provider);
  const screen = useUi((u) => u.screen);
  const back = screen.name === "workspace" ? "workspace" : screen.name === "onboarding" ? "onboarding" : "home";

  return (
    <>
      <section style={{ marginBottom: 18 }}>
        <div className="section-label" style={{ marginTop: 0 }}>
          Where your speech goes
        </div>
        <div className="setting" style={{ alignItems: "center" }}>
          {status === null || downloading ? <div className="spinner" /> : <span className={`dot ${status === "available" ? "pass" : status === "none" ? "fail" : "pending"}`} />}
          <div className="grow">
            <div className="t">
              {downloading
                ? "Downloading the speech model…"
                : status === "available"
                  ? "On this device"
                  : status === "downloadable" || status === "downloading"
                    ? "On this device, after a download"
                    : status === "none"
                      ? "This browser has no voice input"
                      : status === "unavailable"
                        ? "This browser can't do it on the device"
                        : "Checking…"}
            </div>
            <div className="d">
              {status === "available"
                ? `Speech in ${languageName(lang)} is turned into text on this device. Your audio never leaves it.`
                : status === "downloadable" || status === "downloading"
                  ? `Your browser can turn ${languageName(lang)} speech into text on this device after a one-time download of around 60 MB.`
                  : status === "none"
                    ? "Use the dictation key on your keyboard to talk into the message box. Chrome, Edge and Safari have voice input built in."
                    : status === "unavailable"
                      ? `Voice input needs ${service} in this browser. Allow it below, or use the dictation key on your keyboard.`
                      : ""}
            </div>
          </div>
          {(status === "downloadable" || status === "downloading") && !downloading && (
            <button className="btn" onClick={() => void downloadSpeechModel(lang)}>
              <Icon.Download size={14} /> Download
            </button>
          )}
        </div>
        {status !== "none" && (
          <div className="setting">
            <div className="grow">
              <div className="t">Allow {service}</div>
              <div className="d">
                Used only when this device can't turn speech into text itself. While the mic is on, your browser sends your audio to {provider === "other" ? "its maker's service" : company}, which sends back the words under its own privacy policy. Kerf never records, keeps or uploads audio, and only the text you send goes to Anthropic.
              </div>
            </div>
            <Toggle on={s.voiceOnline} onChange={(v) => updateSettings({ voiceOnline: v })} label={`Allow ${service}`} />
          </div>
        )}
      </section>

      <section style={{ marginBottom: 18 }}>
        <div className="section-label" style={{ marginTop: 0 }}>
          Talking
        </div>
        <div className="setting">
          <div className="grow">
            <div className="t">Language</div>
            <div className="d">The language you speak to Claude in. Claude replies in whatever language you write or speak.</div>
          </div>
          <select className="select" value={s.voiceLang} onChange={(e) => updateSettings({ voiceLang: e.target.value })} aria-label="Speech language" style={{ width: 240, maxWidth: "100%" }}>
            <option value="">Same as browser · {languageName(navigator.language || "en-US")}</option>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {languageName(l)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div className="grow">
            <div className="t">After you stop talking</div>
            <div className="d">
              {s.voiceSend === "review"
                ? "Your words wait in the message box so you can check names and numbers before you send."
                : "Kerf sends your words to Claude two seconds after you stop, unless you tap Edit first. Good for hands-free use."}
            </div>
          </div>
          <Segmented<VoiceSend>
            id="voice-send"
            value={s.voiceSend}
            options={[
              { value: "review", label: "review first" },
              { value: "auto", label: "send" },
            ]}
            onChange={(v) => updateSettings({ voiceSend: v })}
          />
        </div>
      </section>
      <div className="help">
        The mic turns off by itself when you pause, after two minutes, or when you switch away from Kerf. Press V to talk, Enter to finish and Escape to cancel.{" "}
        <button
          className="link-btn"
          onClick={() => {
            closeSettings();
            go({ name: "legal", doc: "privacy", back });
          }}
        >
          Privacy notice
        </button>
      </div>
    </>
  );
}
