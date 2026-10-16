// Types for Claude's self-review: an independent reviewer looks at renders,
// measured details and the checks, and returns findings with fixes.

import type { PartInspection, SupportNote } from "../../kernel/inspect";
import type { V3 } from "../../kernel/recipe";

/** The areas every review covers, in the order the card shows them. */
export const AREAS = [
  { id: "brief", label: "Does what was asked" },
  { id: "use", label: "Right for its use" },
  { id: "fit", label: "Fit and assembly" },
  { id: "detail", label: "Detail and finish" },
  { id: "making", label: "Can be made" },
  { id: "look", label: "Proportion and look" },
] as const;
export type AreaId = (typeof AREAS)[number]["id"];

export type Severity = "blocker" | "major" | "minor";

/**
 * open: raised, nothing done yet · fixed: the designer says it is fixed ·
 * verified: a later review confirmed the fix · declined: the designer kept it,
 * with a reason · accepted: the reviewer agreed with that reason · needs_user:
 * only the user can decide · still_open: a later review found it unfixed
 */
export type FindingStatus = "open" | "fixed" | "verified" | "declined" | "accepted" | "needs_user" | "still_open";

export interface Finding {
  /** R1, R2… unique within a review session */
  id: string;
  /** round that raised it */
  round: number;
  severity: Severity;
  area: AreaId;
  title: string;
  detail: string;
  fix: string;
  /** part and component names as written in the source */
  parts: string[];
  /** where it shows: a view name, or "measured" for the detail scan */
  view: string;
  needsUser: boolean;
  status: FindingStatus;
  /** the designer's response, then the reviewer's verdict on it */
  note?: string;
}

export interface ReviewView {
  name: string;
  label: string;
  /** data URL */
  image: string;
  /** set for the reviewer's own close-ups */
  closeup?: { parts: string[]; why: string };
}

export interface AreaResult {
  area: AreaId;
  result: "ok" | "issues" | "n/a";
  note: string;
}

export interface PartDetail {
  /** block name in the source */
  name: string;
  label: string;
  material: string;
  instances: number;
  /** world-space size of the first instance, mm */
  size: V3;
  /** measured details, with locations moved into world space (first instance) */
  inspection: PartInspection | null;
  error?: string;
  /** which of the part's own directions faces the bed when printed as placed in the assembly */
  asPlaced: SupportNote["down"] | null;
}

export interface Literal {
  part: string;
  line: number;
  value: string;
  /** the source line, trimmed */
  context: string;
}

export interface DetailInventory {
  parts: PartDetail[];
  literals: Literal[];
  /** part names left out because the scan could not reach them (not built yet, kernel busy) */
  missing: string[];
}

export interface Brief {
  /** what the design is for, in the user's words */
  text: string;
  /** where the brief came from: the conversation so far, or a saved project brief */
  from: "conversation" | "project";
}

export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
}

export interface ReviewResult {
  round: number;
  verdict: "pass" | "revise" | "decide";
  summary: string;
  /** what the reviewer assumed where the brief was silent */
  assumptions: string;
  checked: AreaResult[];
  /** raised this round */
  findings: Finding[];
  /** earlier findings, with their status after this round */
  earlier: Finding[];
  views: ReviewView[];
  /** every view on one image (JPEG data URL), for the designer and for saved history */
  sheet: string;
  inventory: DetailInventory;
  /** design source the reviewer saw */
  source: string;
  model: string;
  usage: ReviewUsage;
  ms: number;
}

export type ReviewStage = "waiting" | "rendering" | "measuring" | "reviewing" | "closeup" | "writing";

export interface ReviewProgress {
  stage: ReviewStage;
  detail?: string;
  /** views captured so far, for a live preview */
  views?: ReviewView[];
}

/** The designer's answer to a finding, sent with the next review request. */
export interface FindingResponse {
  id: string;
  status: "fixed" | "declined" | "needs_user";
  note: string;
}
