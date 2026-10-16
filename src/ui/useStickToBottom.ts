// Keep a scrolling feed pinned to its newest content while the reader is at
// the bottom, including when content grows after it renders (pictures that
// arrive later, cards that expand).

import { useEffect, useRef, type RefObject } from "react";

export function useStickToBottom(ref: RefObject<HTMLElement | null>, resetKey?: unknown) {
  const stick = useRef(true);
  // something new from the reader (their own message) brings the feed back to the bottom
  useEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, resetKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toBottom = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(toBottom);
    const watch = () => {
      ro.disconnect();
      for (const c of Array.from(el.children)) ro.observe(c);
      toBottom();
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref]);
  return stick;
}
