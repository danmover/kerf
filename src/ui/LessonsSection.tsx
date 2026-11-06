// Settings → AI → Lessons: the rules Claude saved when the user corrected it,
// each one removable, and the switch that stops Claude saving or reading them.

import { useSettings, updateSettings, MAX_LESSONS } from "../app/settings";
import { confirmDialog } from "../app/ui";
import { Toggle } from "./common";
import { Icon } from "./icons";

export function LessonsSection() {
  const s = useSettings();
  const remove = (l: string) => updateSettings({ lessons: useSettings.getState().lessons.filter((x) => x !== l) });
  const clearAll = async () => {
    if (await confirmDialog({ title: "Forget every lesson?", body: "Claude stops following them from your next chat. This cannot be undone.", confirm: "Forget them", danger: true })) updateSettings({ lessons: [] });
  };
  return (
    <section style={{ marginBottom: 18 }}>
      <div className="section-label" style={{ marginTop: 0 }}>
        Lessons
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Learn from corrections</div>
          <div className="d">When you correct something Claude would do again in another design ("I print in PETG", "leave 0.3 mm for a sliding fit"), it saves the rule here and follows it in your later chats. Up to {MAX_LESSONS} are kept on this device; the oldest goes first.</div>
        </div>
        <Toggle on={s.useLessons} onChange={(v) => updateSettings({ useLessons: v })} label="Learn from corrections" />
      </div>
      {s.lessons.length === 0 ? (
        <div className="help">No lessons yet.</div>
      ) : (
        <>
          <ul className="lessons" style={{ listStyle: "none", margin: "4px 0 0", padding: 0, opacity: s.useLessons ? 1 : 0.55 }}>
            {s.lessons.map((l) => (
              <li key={l} className="row" style={{ gap: 6, padding: "4px 0", borderTop: "1px solid var(--line)", alignItems: "flex-start" }}>
                <span className="grow" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                  {l}
                </span>
                <button className="icon-btn sm" onClick={() => remove(l)} aria-label={`Forget: ${l}`} data-tip="Forget this lesson">
                  <Icon.X size={12} />
                </button>
              </li>
            ))}
          </ul>
          <div className="help">
            {s.useLessons ? "Claude reads these at the start of each chat." : "Switched off: Claude neither reads nor saves lessons."}{" "}
            <button type="button" className="link" onClick={() => void clearAll()}>
              Forget them all
            </button>
          </div>
        </>
      )}
    </section>
  );
}
