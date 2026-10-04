import { useTheme } from "../hooks/useTheme";

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "라이트 모드로 전환" : "다크 모드로 전환";

  return (
    <button className="theme-toggle" onClick={toggle} title={label} aria-label={label}>
      {dark ? "☀️" : "🌙"}
    </button>
  );
}
