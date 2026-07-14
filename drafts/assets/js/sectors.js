/* ============================================================================
   SECTOR CONFIG  —  this is the ONE place you edit to add/point sectors.
   ============================================================================

   >>>>>>>>>>  WHERE THE CSV IS LOADED  <<<<<<<<<<
   Each sector's `csv` is a path. It is resolved against CSV_BASE below.

   Two hosting options (both work on GitHub Pages):

   1) SAME REPO (default, recommended)
      Put the clean CSVs in the /data folder of this repo. Leave CSV_BASE = "".
      The dashboard then fetches e.g.  ./data/healthcare.csv  (relative to the site).

   2) RAW GITHUB URL (e.g. CSVs live in another repo/branch)
      Set CSV_BASE to the raw base, e.g.
      CSV_BASE = "https://raw.githubusercontent.com/<user>/<repo>/main/";
      and keep each `csv` as "data/healthcare.csv". The fetch becomes
      https://raw.githubusercontent.com/<user>/<repo>/main/data/healthcare.csv

   NOTE on GitHub Pages: a project site is served from /<repo>/, so relative
   paths like "data/healthcare.csv" resolve correctly as long as the CSVs sit
   next to these pages. If you ever hard-code an absolute path, remember the
   leading "/<repo>/". Relative paths (the default here) avoid that headache.
   ============================================================================ */

const CSV_BASE = ""; // "" = same repo /data folder.  Or a raw.githubusercontent.com base URL.

const SECTORS = [
  {
    id: "healthcare",
    label: "Healthcare",
    csv: "data/healthcare.csv",          // <-- CSV loaded here
    tagline: "Nurses, doctors, care & allied health",
    scope: "ISCO 22 · 32 · 53 + 1342",
    accent: "#0F5B5A",
    icon: "M12 21s-6.7-4.35-9.2-8.06C1 10.24 1.9 6.5 5.2 5.6 7.3 5 9.3 6 12 8.7c2.7-2.7 4.7-3.7 6.8-3.1 3.3.9 4.2 4.64 2.4 7.34C18.7 16.65 12 21 12 21z"
  },
  {
    id: "hospitality",
    label: "Hospitality",
    csv: "data/hospitality.csv",         // <-- CSV loaded here
    tagline: "Hotels, kitchens, service & events",
    scope: "ISCO 14 · 51 · 91 · 94 + more",
    accent: "#C4880C",
    icon: "M4 3h16v2H4zm2 4h12l-1 13H7L6 7zm4 3v7m4-7v7"
  },
  {
    id: "construction",
    label: "Construction",
    csv: "data/construction.csv",        // <-- CSV loaded here
    tagline: "Skilled building trades & site labour",
    scope: "ISCO 71 · 72 · 74 · 83 · 93",
    accent: "#2D9B9A",
    icon: "M3 21h18M6 21V9l6-4 6 4v12M9 21v-6h6v6"
  },
  {
    id: "logistics",
    label: "Logistics & Transport",
    csv: "data/logistics.csv",           // <-- CSV loaded here
    tagline: "Drivers, warehouse, dispatch & supply chain",
    scope: "ISCO 83 · 93 · 43 + more",
    accent: "#3B6E8F",
    icon: "M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 19a2 2 0 100-4 2 2 0 000 4zm10 0a2 2 0 100-4 2 2 0 000 4z"
  }
];

/* Resolve a sector's CSV to its final fetchable URL. */
function csvUrlFor(sector) {
  return CSV_BASE + sector.csv;
}

/* Look up a sector by its id (used by the dashboard via ?sector=…). */
function getSector(id) {
  return SECTORS.find(function (s) { return s.id === id; }) || null;
}
