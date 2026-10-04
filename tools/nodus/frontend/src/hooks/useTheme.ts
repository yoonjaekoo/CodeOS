import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "nodus-theme";
const QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

const darkQuery = window.matchMedia(QUERY);

// The pre-paint script in index.html already set this; re-applying keeps the
// module self-consistent when it is imported without that script.
let current: Theme = storedTheme() ?? (darkQuery.matches ? "dark" : "light");
apply(current);

darkQuery.addEventListener("change", () => {
  if (storedTheme()) return; // an explicit choice always wins over the OS
  current = darkQuery.matches ? "dark" : "light";
  apply(current);
  listeners.forEach((l) => l());
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toggleTheme() {
  current = current === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    // private mode / storage disabled: the theme still applies for this session
  }
  apply(current);
  listeners.forEach((l) => l());
}

export function useTheme() {
  const theme = useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  );
  return { theme, toggle: toggleTheme };
}
