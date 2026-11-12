// The lesson card beside the model: the step to do, a pointer at where to do it, and Show me, Write it for me, Back
// and Next. It follows what the user does (src/learn/runtime.ts) and moves on by itself when a step is done.

import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { applyStep, backStep, closeLesson, lessonAfter, nextStep, setCollapsed, showStep, startLesson, useLearn } from "../../learn/runtime";
import { lessonById, type Lesson } from "../../learn/lessons";
import { useProject } from "../../app/project";
import { openSettings } from "../../app/ui";
import { useSketch } from "../sketch/session";
import { useApiKey } from "../ChatPanel";
import { Icon } from "../icons";
import { LearnGlyph } from "./glyph";
import "../../styles/learn.css";

/** a step's text: `code` in backticks, a line break for each new line */
function Text({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line.split("`").map((part, j) => (j % 2 ? <code key={j}>{part}</code> : <Fragment key={j}>{part}</Fragment>))}
        </Fragment>
      ))}
    </>
  );
}

const kindLabel = (l: Lesson) => (l.kind === "tutorial" ? "Tutorial" : "Feature sample");

export function Coach({ bottom }: { bottom: number }) {
  const active = useLearn((s) => s.active);
  const collapsed = useLearn((s) => s.collapsed);
  const pulse = useLearn((s) => s.pulse);
  const project = useProject((s) => s.current?.id);
  const sketching = useSketch((s) => !!s.active || s.picking);
  const key = useApiKey();
  const lesson = lessonById(active?.lesson);
  if (!active || !lesson || active.project !== project) return null;
  const total = lesson.steps.length;
  const finished = active.step >= total;
  const step = finished ? null : lesson.steps[active.step];
  const after = finished ? lessonAfter(lesson) : undefined;
  const label = `${kindLabel(lesson)}: ${lesson.name}`;
  let body: ReactNode;
  if (collapsed)
    body = (
      <button className="coach-pill" onClick={() => setCollapsed(false)} aria-label={`Show the ${kindLabel(lesson).toLowerCase()}`}>
        <LearnGlyph size={13} />
        <span className="coach-pill-n">{finished ? "Done" : `${active.step + 1}/${total}`}</span>
        <span className="coach-pill-t">{step?.title ?? lesson.name}</span>
        <Icon.ChevronDown size={12} style={{ transform: "rotate(180deg)" }} />
      </button>
    );
  else
    body = (
      <>
        <div className="coach-head">
          <span className="coach-icon">
            <LearnGlyph size={14} />
          </span>
          <div className="coach-what">
            <div className="coach-kind">
              {kindLabel(lesson)}
              {!finished && (
                <span className="coach-count">
                  {" "}
                  · {active.step + 1} of {total}
                </span>
              )}
            </div>
            <div className="coach-name">{lesson.name}</div>
          </div>
          <button className="icon-btn sm" onClick={() => setCollapsed(true)} aria-label="Fold the lesson away" data-tip="Fold away">
            <Icon.ChevronDown size={14} />
          </button>
          <button className="icon-btn sm" onClick={closeLesson} aria-label="Close the lesson" data-tip="Close (Ctrl+K, then the lesson's name, shows it again)">
            <Icon.X size={14} />
          </button>
        </div>
        <div className="coach-steps" aria-hidden>
          {lesson.steps.map((_, i) => (
            <span key={i} className={i < active.step || finished ? "done" : i === active.step ? (active.passed ? "done now" : "now") : ""} />
          ))}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={finished ? "end" : active.step} className="coach-body" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.16 }}>
            {step ? (
              <>
                <div className={`coach-title ${active.passed ? "passed" : ""}`}>
                  {active.passed && <Icon.Check size={13} />}
                  {step.title}
                </div>
                <div className="coach-text">
                  <Text text={step.body} />
                </div>
                {lesson.needsKey && !key && (
                  <div className="coach-note">
                    Claude needs a key for this one.{" "}
                    <button className="link" onClick={() => openSettings("ai")}>
                      Settings → AI
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="coach-title passed">
                  <Icon.Check size={13} /> {lesson.kind === "tutorial" ? "Tutorial done" : "That's the tour"}
                </div>
                <div className="coach-text">{after ? `Next: ${after.name}. ${after.about}` : "That's every tutorial. The feature samples on the home screen each show one thing Kerf does."}</div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
        <div className="coach-actions">
          {active.step > 0 && (
            <button className="btn sm ghost" onClick={backStep} aria-label="Back a step">
              <Icon.Chevron size={12} style={{ transform: "rotate(180deg)" }} />
            </button>
          )}
          {step && (step.target || step.show) && (
            <button className="btn sm" onClick={showStep} data-tip="Open what this step is about and point at it">
              <Icon.Target size={12} /> Show me
            </button>
          )}
          {step?.apply && !active.passed && (
            <button className="btn sm" onClick={applyStep} data-tip="Make this step's change in the design file; Ctrl+Z takes it back">
              <Icon.Wand size={12} /> Write it for me
            </button>
          )}
          <div className="grow" />
          {step ? (
            <button className={`btn sm ${!step.done || active.passed ? "primary" : "ghost"}`} onClick={nextStep}>
              {active.step === total - 1 ? "Finish" : step.done && !active.passed ? "Skip" : "Next"}
            </button>
          ) : after ? (
            <>
              <button className="btn sm ghost" onClick={closeLesson}>
                Close
              </button>
              <button className="btn sm primary" onClick={() => void startLesson(after.id)}>
                Start the next
              </button>
            </>
          ) : (
            <button className="btn sm primary" onClick={closeLesson}>
              Close
            </button>
          )}
        </div>
      </>
    );
  return (
    <div className="coach-anchor" style={{ bottom }}>
      <motion.div className={`coach ${collapsed ? "folded" : ""} ${sketching ? "beside-tools" : ""}`} role="region" aria-label={label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        {body}
      </motion.div>
      {!collapsed && step?.target && !active.passed && <Pointer selector={step.target} pulse={pulse} />}
    </div>
  );
}

/** A ring round the first visible element the step points at, kept on it as the layout moves. */
function Pointer({ selector, pulse }: { selector: string; pulse: number }) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const find = () => {
      if (!alive) return;
      let found: DOMRect | null = null;
      try {
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
            found = r;
            break;
          }
        }
      } catch {
        /* a selector the page can't read */
      }
      setBox((b) => (found ? (b && b.x === found.x && b.y === found.y && b.w === found.width && b.h === found.height ? b : { x: found.x, y: found.y, w: found.width, h: found.height }) : null));
    };
    find();
    const t = window.setInterval(find, 300);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selector]);
  // Show me brings the element into view
  useEffect(() => {
    if (!pulse) return;
    try {
      document.querySelector(selector)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } catch {
      /* a selector the page can't read */
    }
  }, [pulse, selector]);
  if (!box) return null;
  const pad = 4;
  return createPortal(
    <div className="coach-ring" key={pulse} style={{ left: box.x - pad, top: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2 }} aria-hidden />,
    document.body,
  );
}
