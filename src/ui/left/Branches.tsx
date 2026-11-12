// History's branches: the bar over the version list says which branch is open and what it was made from, switches
// between branches, merges one back or takes its parent's changes, and shows the parent to compare. A merge where both
// changed the same lines opens a dialog to choose what to keep in each place.

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { applyMerge, createBranch, deleteBranch, endPreview, openBranch, planMerge, previewSource, projectBranches, renameBranch, switchBranch, useProject, type MergePlan } from "../../app/project";
import { MAIN, branchList, branchOf, firstChoice, mergeState, mergedText, nextBranchName, type MergeChoice, type MergeConflict } from "../../core/branches";
import { useDesign } from "../../core/engine";
import { useChat } from "../../ai/chat";
import { confirmDialog, toast } from "../../app/ui";
import type { BranchRecord, VersionRecord } from "../../persist/db";
import { useRealModel } from "../useRealModel";
import { Icon } from "../icons";
import { Menu, MenuItem, Modal, timeAgo } from "../common";

interface BranchUi {
  /** naming a new branch (from the design as it is, or from a version) or renaming one */
  naming: null | { mode: "new"; from?: VersionRecord } | { mode: "rename"; id: string };
  /** a merge waiting on the user's choices */
  merging: MergePlan | null;
}
export const useBranchUi = create<BranchUi>(() => ({ naming: null, merging: null }));

/** Start naming a new branch made from the design as it is, or from an earlier version. */
export const startNewBranch = (from?: VersionRecord) => useBranchUi.setState({ naming: { mode: "new", ...(from ? { from } : {}) } });

/** How a sentence names a branch: main plainly, the others quoted. */
const called = (b: { id: string; name: string } | undefined) => (!b ? "that branch" : b.id === MAIN ? "main" : `“${b.name}”`);
const byId = (id: string) => projectBranches().find((b) => b.id === id);

/** Claude edits the design on screen: branches wait for it. */
function claudeBusy() {
  if (!useChat.getState().busy) return false;
  toast({ kind: "info", title: "Claude is working on the design", detail: "Switch or merge branches when it has finished." });
  return true;
}

/** Open another branch. */
export async function openBranchNamed(id: string) {
  if (claudeBusy()) return;
  const why = await switchBranch(id);
  if (why) toast({ kind: "warn", title: "Didn't switch branches", detail: why });
}

/** Merge branch `from` into `into`: straight in when nothing clashes, else through the dialog. */
export async function startMerge(from: string, into: string) {
  if (claudeBusy()) return;
  const plan = planMerge(from, into);
  if (typeof plan === "string") return void toast({ kind: "warn", title: "Can't merge those", detail: plan });
  const a = byId(from);
  const b = byId(into);
  if (plan.upToDate) return void toast({ kind: "info", title: `${called(b)} already has everything from ${called(a)}` });
  if (plan.result.conflicts.length) return void useBranchUi.setState({ merging: plan });
  await finishMerge(plan, mergedText(plan.result, () => "ours"));
}

async function finishMerge(plan: MergePlan, text: string) {
  const a = byId(plan.from);
  const b = byId(plan.into);
  const why = await applyMerge(plan, text);
  if (why) return void toast({ kind: "warn", title: "Didn't merge", detail: why });
  const err = useDesign.getState().model?.diagnostics.find((d) => d.severity === "error");
  const title = b?.from === plan.from ? `${called(b)} has ${called(a)}'s changes` : `Merged ${called(a)} into ${called(b)}`;
  if (err) toast({ kind: "warn", title: `${title}, but the design has an error now`, detail: `${err.message} Undo takes the merge back.` }, 9000);
  else toast({ kind: "success", title, detail: "Undo takes it back." });
}

/** The line under a branch's name in the menu. */
function describe(b: BranchRecord, list: BranchRecord[], count: number) {
  const parts: string[] = [];
  if (b.from) parts.push(`from ${list.find((x) => x.id === b.from)?.name ?? MAIN}`);
  parts.push(count === 1 ? "1 version" : `${count} versions`);
  const merged = [...(b.meets ?? [])].reverse().find((m) => m.kind === "merged");
  if (merged) parts.push(`merged ${timeAgo(merged.ts)}`);
  return parts.join(" · ");
}

export function BranchBar() {
  const current = useProject((s) => s.current);
  const versions = useProject((s) => s.versions);
  const naming = useBranchUi((s) => s.naming);
  const busy = useChat((s) => s.busy);
  const { source } = useRealModel();
  const open = openBranch(current);
  const list = useMemo(() => (current ? branchList(current).map((b) => (b.id === open ? { ...b, head: source } : b)) : []), [current, open, source]);
  const here = list.find((b) => b.id === open) ?? list[0];
  const parent = here?.from ? list.find((b) => b.id === here.from) : undefined;
  const state = useMemo(() => (here && parent ? mergeState(here, parent.head, here.head) : null), [here, parent]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of versions) m.set(branchOf(v), (m.get(branchOf(v)) ?? 0) + 1);
    return m;
  }, [versions]);
  const compareKey = `branch:${parent?.id ?? ""}`;
  const comparing = useProject((s) => s.preview?.key === compareKey);
  useEffect(() => () => endPreview(compareKey), [compareKey]);
  if (!current || !here) return null;

  const remove = async () => {
    const n = counts.get(here.id) ?? 0;
    const merged = here.meets?.some((m) => m.kind === "merged");
    const ok = await confirmDialog({
      title: `Delete ${called(here)}?`,
      body: `Its ${n === 1 ? "version goes" : `${n} versions go`} with it, and the design goes back to ${called(parent)}.${merged ? ` What was merged into ${called(parent)} stays there.` : " Nothing on it has been merged anywhere."}`,
      confirm: "Delete branch",
      danger: true,
    });
    if (!ok) return;
    const why = await deleteBranch(here.id);
    if (why) toast({ kind: "warn", title: "Didn't delete the branch", detail: why });
  };
  const compare = () => (comparing ? endPreview(compareKey) : parent && previewSource({ key: compareKey, label: `${called(parent)} as it is now, to compare with ${called(here)}` }, parent.head));

  return (
    <div className={`lp-branchbar ${parent ? "on-branch" : ""}`}>
      <div className="lp-branch-row">
        <Menu
          width={300}
          trigger={(isOpen, toggle) => (
            <button className={`lp-branch-pick ${isOpen ? "open" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={isOpen}>
              <Icon.Branch size={13} />
              <span className="lp-branch-name">{here.name}</span>
              <Icon.ChevronDown size={11} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-label">Branches</div>
              {list.map((b) => (
                <button
                  key={b.id}
                  className="menu-item lp-branch-item"
                  role="menuitemcheckbox"
                  aria-checked={b.id === open}
                  disabled={busy && b.id !== open}
                  onClick={() => {
                    close();
                    if (b.id !== open) void openBranchNamed(b.id);
                  }}
                >
                  <span className="lp-branch-check">{b.id === open && <Icon.Check size={12} />}</span>
                  <span className="lp-branch-item-text">
                    <span className="lp-branch-item-name">{b.name}</span>
                    <span className="lp-branch-item-sub">{describe(b, list, counts.get(b.id) ?? 0)}</span>
                  </span>
                </button>
              ))}
              <div className="menu-sep" />
              <MenuItem
                icon={<Icon.Plus size={13} />}
                disabled={busy}
                onClick={() => {
                  close();
                  startNewBranch();
                }}
              >
                New branch from here
              </MenuItem>
              {here.id !== MAIN && (
                <MenuItem
                  icon={<Icon.Edit size={13} />}
                  onClick={() => {
                    close();
                    useBranchUi.setState({ naming: { mode: "rename", id: here.id } });
                  }}
                >
                  Rename {called(here)}
                </MenuItem>
              )}
              {here.id !== MAIN && (
                <MenuItem
                  icon={<Icon.Trash size={13} />}
                  danger
                  disabled={busy}
                  onClick={() => {
                    close();
                    void remove();
                  }}
                >
                  Delete {called(here)}
                </MenuItem>
              )}
            </>
          )}
        </Menu>
        <span className="grow" />
        {!naming && (
          <button className="lp-tool-btn" disabled={busy} onClick={() => startNewBranch()} data-tip="Try something on a branch of its own, kept apart until you merge it">
            <Icon.Plus size={12} /> Branch
          </button>
        )}
      </div>
      {naming && <BranchName list={list} />}
      {parent && !naming && (
        <>
          <div className="lp-branch-info">
            <span>
              Made from {called(parent)} {timeAgo(here.createdAt)}
              {state?.behind && <span className="lp-branch-behind"> · {called(parent)} has changed since</span>}
            </span>
            <button className={`lp-icon-btn ${comparing ? "on" : ""}`} aria-pressed={comparing} disabled={busy && !comparing} onClick={compare} aria-label={`Compare with ${parent.name}`} data-tip={comparing ? "Stop comparing" : `Show ${called(parent)} in the 3D view to compare`} data-tip-pos="left">
              {comparing ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
            </button>
          </div>
          <div className="lp-branch-acts">
            <button className="btn sm" disabled={busy || !state?.ahead} onClick={() => void startMerge(here.id, parent.id)} data-tip={state?.ahead ? `Bring what changed on ${called(here)} into ${called(parent)}` : `${called(parent)} already has everything from here`}>
              <Icon.Merge size={12} /> Merge into {parent.id === MAIN ? "main" : parent.name}
            </button>
            <button className="btn sm ghost" disabled={busy || !state?.behind} onClick={() => void startMerge(parent.id, here.id)} data-tip={state?.behind ? `Bring what changed on ${called(parent)} since into this branch` : `Nothing new on ${called(parent)} since`}>
              Catch up
            </button>
          </div>
        </>
      )}
      <MergeDialog />
    </div>
  );
}

/** The field that names a new branch, or renames one. */
function BranchName({ list }: { list: BranchRecord[] }) {
  const naming = useBranchUi((s) => s.naming)!;
  const renaming = naming.mode === "rename" ? list.find((b) => b.id === naming.id) : undefined;
  const from = naming.mode === "new" ? naming.from : undefined;
  const [value, setValue] = useState(() => renaming?.name ?? nextBranchName(list));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const cancel = () => useBranchUi.setState({ naming: null });
  const submit = async () => {
    if (saving) return;
    if (renaming) {
      const why = renameBranch(renaming.id, value);
      if (why) return setProblem(why);
      return cancel();
    }
    if (claudeBusy()) return;
    setSaving(true);
    const why = await createBranch(value, from ? { from } : {});
    setSaving(false);
    if (why) return setProblem(why);
    cancel();
  };
  const fromWhen = from ? new Date(from.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <form
      className="lp-branch-naming"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="lp-branch-naming-label">{renaming ? `Rename ${called(renaming)}` : from ? `New branch from the version of ${fromWhen}` : "New branch from the design as it is"}</div>
      <div className="lp-branch-naming-row">
        <input
          ref={input}
          value={value}
          maxLength={40}
          spellCheck={false}
          aria-label="Branch name"
          aria-invalid={!!problem}
          onChange={(e) => {
            setValue(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              cancel();
            }
          }}
        />
        <button type="submit" className="btn sm primary" disabled={saving}>
          {renaming ? "Rename" : "Create"}
        </button>
        <button type="button" className="lp-icon-btn" onClick={cancel} aria-label="Cancel">
          <Icon.X size={12} />
        </button>
      </div>
      {problem && <div className="lp-branch-problem">{problem}</div>}
    </form>
  );
}

/** Each place both branches changed, with a choice of what to keep. */
function MergeDialog() {
  const plan = useBranchUi((s) => s.merging);
  const [picks, setPicks] = useState<(MergeChoice | undefined)[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicks(plan ? plan.result.conflicts.map(firstChoice) : []), [plan]);
  const a = plan ? byId(plan.from) : undefined;
  const b = plan ? byId(plan.into) : undefined;
  const close = () => useBranchUi.setState({ merging: null });
  const n = plan?.result.conflicts.length ?? 0;
  const clean = plan ? plan.result.fromOurs + plan.result.fromTheirs : 0;
  const ready = n > 0 && picks.length === n && picks.every(Boolean);
  const go = async () => {
    if (!plan || !ready) return;
    setBusy(true);
    await finishMerge(plan, mergedText(plan.result, (_, i) => picks[i]!));
    setBusy(false);
    close();
  };
  const theirsName = a?.id === MAIN ? "main" : (a?.name ?? "");
  const oursName = b?.id === MAIN ? "main" : (b?.name ?? "");
  const all = (k: MergeChoice) => setPicks(plan!.result.conflicts.map(() => k));
  return (
    <Modal
      open={!!plan}
      onClose={close}
      title={b?.from === plan?.from ? `Take ${called(a)}'s changes into ${called(b)}` : `Merge ${called(a)} into ${called(b)}`}
      icon={<Icon.Merge size={16} />}
      width={760}
      footer={
        <>
          <button className="btn ghost sm" onClick={() => all("ours")}>
            Keep all of {oursName}'s
          </button>
          <button className="btn ghost sm" onClick={() => all("theirs")}>
            Keep all of {theirsName}'s
          </button>
          <span className="grow" />
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready || busy} onClick={() => void go()}>
            Merge
          </button>
        </>
      }
    >
      <div className="modal-body lp-merge">
        <p className="muted">
          {n === 1 ? "One place was" : `${n} places were`} changed on both branches since they last met. Choose what to keep in each.
          {clean > 0 && ` The other ${clean === 1 ? "change merges" : `${clean} changes merge`} on ${clean === 1 ? "its" : "their"} own.`}
        </p>
        {plan?.result.conflicts.map((c, i) => (
          <ConflictCard key={i} c={c} pick={picks[i]} oursName={oursName} theirsName={theirsName} onPick={(k) => setPicks((p) => p.map((x, j) => (j === i ? k : x)))} />
        ))}
      </div>
    </Modal>
  );
}

function ConflictCard({ c, pick, oursName, theirsName, onPick }: { c: MergeConflict; pick?: MergeChoice; oursName: string; theirsName: string; onPick: (k: MergeChoice) => void }) {
  const side = (k: "ours" | "theirs", name: string, lines: string[]) => (
    <button className={`lp-merge-side ${pick === k ? "on" : ""}`} onClick={() => onPick(k)} aria-pressed={pick === k}>
      <span className="lp-merge-side-head">
        <span className="lp-merge-radio" aria-hidden="true" />
        Keep {name}'s
      </span>
      <pre className="lp-merge-code">{lines.length ? lines.join("\n") : "(removed there)"}</pre>
    </button>
  );
  return (
    <section className="lp-merge-card">
      <div className="lp-merge-where">
        {c.where ? `${c.where} · line ${c.line}` : `Near the top, line ${c.line}`}
      </div>
      <div className="lp-merge-sides">
        {side("ours", oursName, c.ours)}
        {side("theirs", theirsName, c.theirs)}
      </div>
      {c.ours.length > 0 && c.theirs.length > 0 && (
        <button className={`lp-merge-both ${pick === "both" ? "on" : ""}`} onClick={() => onPick("both")} aria-pressed={pick === "both"}>
          <span className="lp-merge-radio" aria-hidden="true" />
          Keep both, {oursName}'s first
        </button>
      )}
    </section>
  );
}
