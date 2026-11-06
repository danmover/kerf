// Lessons Claude saves when the user corrects it: a rule in a sentence ("I
// print in PETG", "use M4 screws for anything that holds weight"), kept in
// Settings on this device and given to Claude at the start of every chat, so a
// correction is made once instead of in every design. The user sees each one
// saved in the chat and can remove any in Settings → AI → Lessons.

import { z } from "zod";
import { cleanLessons, updateSettings, useSettings, MAX_LESSONS } from "../app/settings";

export const LESSON_TOOL = {
  name: "save_lesson",
  description:
    "Save a lesson from the user's correction, so it holds in their other chats and designs too: a rule in one sentence, in their terms (\"Prints in PETG on a 0.4 mm nozzle\", \"Use M4 screws for anything that carries weight\", \"No fillets on edges nobody sees\"). Only for what they would correct again in another design: a preference, a habit, a convention or a mistake you made. Not for this design's own sizes, and not for a lesson you already have. Give replaces to reword or correct one you have.",
  input_schema: {
    type: "object" as const,
    properties: {
      lesson: { type: "string", description: "The rule, one sentence of at most 200 characters." },
      replaces: { type: "string", description: "A lesson you already have, word for word, that this one corrects or rewords." },
    },
    required: ["lesson"],
    additionalProperties: false,
  },
};

export const LessonInput = z.object({ lesson: z.string().trim().min(3).max(200), replaces: z.string().trim().max(200).optional() });

/** Save a lesson; returns what Claude is told. */
export function saveLesson(lesson: string, replaces?: string): { text: string; saved: boolean } {
  const s = useSettings.getState();
  if (!s.useLessons) return { text: "Lessons are switched off in Settings, so nothing was saved. Follow the correction in this chat.", saved: false };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (s.lessons.some((l) => same(l, lesson))) return { text: "You already have this lesson.", saved: false };
  let list = replaces ? s.lessons.filter((l) => !same(l, replaces)) : [...s.lessons];
  const replaced = list.length < s.lessons.length;
  list.push(lesson);
  const dropped = list.length > MAX_LESSONS ? list[0] : null;
  list = cleanLessons(list.slice(-MAX_LESSONS));
  updateSettings({ lessons: list });
  return {
    text: `Saved${replaced ? `, in place of "${replaces}"` : ""}. It holds in the user's other chats from their next one.${dropped ? ` The list was full, so the oldest lesson went: "${dropped}".` : ""}`,
    saved: true,
  };
}

/** The lessons as the system prompt gives them, or nothing. */
export function lessonsPrompt(lessons: readonly string[]): string {
  if (!lessons.length) return "";
  return `\n\n## Lessons this user taught you\nRules the user gave you when they corrected you, in this chat or earlier ones. Follow them unless the user now asks otherwise, and save a corrected one with save_lesson's replaces.\n${lessons.map((l) => `- ${l}`).join("\n")}`;
}
