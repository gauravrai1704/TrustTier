// Inline stroke icons (24px grid, 1.8px stroke) - no icon font or CDN.
const P = {
  overview: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  positions: "M4 6h16M4 12h16M4 18h10",
  watch: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4",
  economics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  protocol: "M12 2l9 5v10l-9 5-9-5V7l9-5zM12 22V12M21 7l-9 5-9-5",
  sun: "M12 4V2M12 22v-2M4.9 4.9L3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 17a5 5 0 100-10 5 5 0 000 10z",
  moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z",
  wallet: "M3 7h15a3 3 0 013 3v7a3 3 0 01-3 3H6a3 3 0 01-3-3V7zm0 0l2-3h11M17 14h.01",
  play: "M7 4l13 8-13 8V4z",
  plus: "M12 5v14M5 12h14",
  forward: "M4 5l7 7-7 7M13 5l7 7-7 7",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  info: "M12 16v-4M12 8h.01M12 22a10 10 0 100-20 10 10 0 000 20z",
  lock: "M6 11h12v10H6V11zM8 11V7a4 4 0 118 0v4",
  key: "M15 7a4 4 0 11-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0115 7z",
  hammer: "M14 4l6 6-3 3-6-6 3-3zM11 7l-8 8 3 3 8-8",
  coin: "M12 21a9 9 0 100-18 9 9 0 000 18zM9 10a3 2 0 016 0c0 2-6 2-6 4a3 2 0 006 0M12 6v2M12 16v2",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  clock: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
  trend: "M3 17l6-6 4 4 8-8M15 7h6v6",
  down: "M3 7l6 6 4-4 8 8M15 17h6v-6",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z",
  cpu: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M6 5h12v14H6V5zM9 9h6v6H9V9z",
  doc: "M14 3H6v18h12V7l-4-4zM14 3v4h4M9 13h6M9 17h6",
  link: "M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1",
  layers: "M12 2l10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  reset: "M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8M3 3v5h5",
  chevron: "M9 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};

export default function Icon({ name, className, title }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] || P.info} />
    </svg>
  );
}

export function Logo({ className = "brand-mark" }) {
  // Three stacked tiers rising to a check: verification that grows with risk.
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="11" fill="var(--accent)" />
      <rect x="9" y="25" width="22" height="5" rx="2.5" fill="var(--accent-ink)" opacity="0.55" />
      <rect x="12" y="18" width="16" height="5" rx="2.5" fill="var(--accent-ink)" opacity="0.78" />
      <rect x="15" y="11" width="10" height="5" rx="2.5" fill="var(--accent-ink)" />
    </svg>
  );
}
