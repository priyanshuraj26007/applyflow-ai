// ==========================================
// APPLYFLOW AI — shared line icons + logo
// Loaded by content.js (LinkedIn) and by every extension page.
// All icons use currentColor, so they follow light/dark automatically.
// ==========================================
const AF_ICONS = (() => {
  const line = (paths, size = 16, width = 1.8) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  return {
    // Logo: icon A (paper plane in a squircle). Colours come from CSS (.af-logo-bg / .af-logo-fg).
    logo: (size = 28) =>
      `<svg class="af-logo" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">` +
      `<rect class="af-logo-bg" width="64" height="64" rx="15"/>` +
      `<path class="af-logo-fg" d="M13 31.5 L51 15 L41.5 49 L30.5 36.5 Z M30.5 36.5 L51 15" fill="none" stroke-width="${size < 24 ? 5 : 4}" stroke-linejoin="round" stroke-linecap="round"/></svg>`,

    send: (s) => line('<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>', s, 2),
    attach: (s) => line('<path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>', s),
    close: (s) => line('<path d="M6 6l12 12M18 6L6 18"/>', s),
    external: (s) => line('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', s),
    chevronLeft: (s) => line('<path d="M15 6l-6 6 6 6"/>', s, 2),
    chevronRight: (s) => line('<path d="M9 6l6 6-6 6"/>', s, 2),
    chevronDown: (s) => line('<path d="M6 9l6 6 6-6"/>', s, 2),
    check: (s) => line('<path d="M5 12.5l4.5 4.5L19 7.5"/>', s, 2.2),
    refresh: (s) => line('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', s, 2),
    doc: (s) => line('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>', s),
    clock: (s) => line('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', s),
    mail: (s) => line('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>', s),
    sparkle: (s) => line('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', s),
    user: (s) => line('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/>', s),
    upload: (s) => line('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', s),
    trash: (s) => line('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>', s),
    eye: (s) => line('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', s),
    star: (s) => line('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>', s),
    warning: (s) => line('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>', s),
    grip: (s) => line('<circle cx="9" cy="6" r=".6"/><circle cx="15" cy="6" r=".6"/><circle cx="9" cy="12" r=".6"/><circle cx="15" cy="12" r=".6"/><circle cx="9" cy="18" r=".6"/><circle cx="15" cy="18" r=".6"/>', s, 2.4)
  };
})();

// Score ring used for resume matches (0-100).
function afScoreRing(score, size = 34) {
  const r = 15, c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return `<svg class="af-ring" width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true">` +
    `<circle class="af-ring-track" cx="18" cy="18" r="${r}" fill="none" stroke-width="3"/>` +
    `<circle class="af-ring-fill" cx="18" cy="18" r="${r}" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 18 18)"/>` +
    `<text x="18" y="22" text-anchor="middle" font-size="11" font-weight="700">${Math.round(score)}</text></svg>`;
}
