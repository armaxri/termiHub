import { useEffect, type RefObject } from "react";

/**
 * Scroll an opened History entry so that its name is on top of the list (B-034): its
 * details need the room a short window has. Only the list itself scrolls.
 */
export function useRevealWhenOpened(row: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    const entry = row.current;
    const list = entry?.closest<HTMLElement>(".automation-history__list");
    if (!open || !entry || !list) return;
    list.scrollTop += entry.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }, [row, open]);
}
