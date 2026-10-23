// Ranking for the find palette (ui/FindPalette): every view, panel, tool,
// analysis, export, template and setting is an item, and what the user types
// is matched against its title, the other words people use for it ("wind
// tunnel" for airflow, "mold" for mould, "FEA" for strength) and its detail
// line. Plain words, no fuzzy magic: each word typed has to start a word the
// item is known by, or appear inside its title.

export interface Findable {
  title: string;
  /** other words for it, space separated */
  keywords?: string;
  detail?: string;
  group?: string;
}

/** lower case, accents gone, punctuation as spaces */
export function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.+#]+/g, " ")
    .trim();
}

const words = (s: string) => norm(s).split(" ").filter(Boolean);

/** British and American spellings either way round, so "mold" finds mould and "colour" finds color */
const SPELLINGS: [string, string][] = [
  ["mould", "mold"],
  ["colour", "color"],
  ["aluminium", "aluminum"],
  ["centre", "center"],
  ["metre", "meter"],
  ["analyse", "analyze"],
  ["optimise", "optimize"],
  ["visualise", "visualize"],
  ["tyre", "tire"],
];
function spellings(w: string): string[] {
  const out = [w];
  for (const [uk, us] of SPELLINGS) {
    if (w.startsWith(uk)) out.push(us + w.slice(uk.length));
    else if (w.startsWith(us)) out.push(uk + w.slice(us.length));
  }
  return out;
}

/**
 * How well a query matches an item: 0 when some word typed matches nothing,
 * higher for better matches. A word starting the title counts most, then a
 * word starting any title word, a word inside the title, a word starting one
 * of its other names, and last a word in the detail line.
 */
export function score(query: string, item: Findable): number {
  const q = words(query);
  if (!q.length) return 1;
  const title = norm(item.title);
  const tw = title.split(" ");
  const kw = words(item.keywords ?? "");
  const dw = words(item.detail ?? "");
  const gw = words(item.group ?? "");
  let total = 0;
  for (const raw of q) {
    let best = 0;
    for (const w of spellings(raw)) {
      if (tw[0]?.startsWith(w)) best = Math.max(best, 4);
      else if (tw.some((t) => t.startsWith(w))) best = Math.max(best, 3);
      else if (w.length >= 3 && title.includes(w)) best = Math.max(best, 2);
      else if (kw.some((k) => k.startsWith(w))) best = Math.max(best, w.length >= 3 || kw.includes(w) ? 1.6 : 0);
      else if (w.length >= 3 && dw.some((d) => d.startsWith(w))) best = Math.max(best, 0.8);
      else if (gw.some((g) => g.startsWith(w))) best = Math.max(best, 0.5);
    }
    if (!best) return 0;
    total += best;
  }
  // the whole query starting the title, and short titles, edge ahead
  const whole = q.join(" ");
  if (title.startsWith(whole)) total += 3;
  return total + 1 / (4 + tw.length);
}

/** The items matching a query, best first; items keep their order when they score the same. */
export function rank<T extends Findable>(query: string, items: readonly T[], limit = 60): T[] {
  if (!words(query).length) return items.slice();
  return items
    .map((it, i) => ({ it, i, s: score(query, it) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

/**
 * Whether what was typed reads like something to say to Claude rather than
 * the name of a feature: a sentence (three or more words, or a question), or
 * nothing that matches well.
 */
export function readsLikeAsk(query: string, best: Findable | undefined): boolean {
  const q = words(query);
  if (!q.length) return false;
  if (q.length >= 3 || /\?\s*$/.test(query)) return true;
  return !best || score(query, best) < 3;
}
