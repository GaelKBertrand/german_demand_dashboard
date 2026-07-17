/* ============================================================================
   SECTOR CONFIG  —  the ONE place you edit to add / point sectors.
   ============================================================================
   WHERE THE CSV IS LOADED: each sector's `csv` is resolved against CSV_BASE.
     1) SAME REPO (default): put clean CSVs in /data, leave CSV_BASE = "".
        Fetches e.g.  ./data/healthcare.csv
     2) RAW GITHUB URL: set CSV_BASE to a raw base and keep csv = "data/x.csv".
   Relative paths (default) resolve correctly under a /<repo>/ Pages site.
   ============================================================================ */

const CSV_BASE = ""; // "" = same-repo /data folder, or a raw.githubusercontent.com base URL

const SECTORS = [
  {
    id: "healthcare", label: "Healthcare", csv: "data/healthcare.csv",
    tagline: "Nurses, doctors, care & allied health",
    scope: "ISCO 22 · 32 · 53", accent: "#0F5B5A",
    source: "StepStone Germany",
    kpiNoun: "Clinical Healthcare",     // used in KPI/alert copy
    /* Optional narrative tabs loaded from /content at runtime. Remove to hide. */
    staticTabs: [
      { id: "about", label: "About & Methods",        file: "content/healthcare-about.html" },
      { id: "quals", label: "Qualifications & Skills", file: "content/healthcare-quals.html" }
    ],
    icon: "M12 21s-6.7-4.35-9.2-8.06C1 10.24 1.9 6.5 5.2 5.6 7.3 5 9.3 6 12 8.7c2.7-2.7 4.7-3.7 6.8-3.1 3.3.9 4.2 4.64 2.4 7.34C18.7 16.65 12 21 12 21z"
  },
  {
    id: "hospitality", label: "Hospitality", csv: "data/hospitality.csv",
    tagline: "Hotels, kitchens, service & events",
    scope: "ISCO 14 · 51 · 91 · 94", accent: "#C4880C",
    source: "StepStone Germany", kpiNoun: "Hospitality",
    staticTabs: [],
    icon: "M4 3h16v2H4zm2 4h12l-1 13H7L6 7zm4 3v7m4-7v7"
  },
  {
    id: "construction", label: "Construction", csv: "data/construction.csv",
    tagline: "Skilled building trades & site labour",
    scope: "ISCO 71 · 72 · 74 · 93", accent: "#2D9B9A",
    source: "StepStone Germany", kpiNoun: "Construction",
    staticTabs: [],
    icon: "M3 21h18M6 21V9l6-4 6 4v12M9 21v-6h6v6"
  },
  {
    id: "logistics", label: "Logistics & Transport", csv: "data/logistics.csv",
    tagline: "Drivers, warehouse, dispatch & supply chain",
    scope: "ISCO 83 · 93 · 43", accent: "#3B6E8F",
    source: "StepStone Germany", kpiNoun: "Logistics",
    staticTabs: [],
    icon: "M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 19a2 2 0 100-4 2 2 0 000 4zm10 0a2 2 0 100-4 2 2 0 000 4z"
  }
];

/* ---------------------------------------------------------------------------
   REGION (Germany) — shared map config for the Regional tab. All sectors here
   are Germany/StepStone. To add another country, add a REGION and point a
   sector at it via sector.region.
   --------------------------------------------------------------------------- */
const REGIONS = {
  germany: {
    label: "Germany",
    unit: "Bundesländer",
    center: [51.2, 10.4], zoom: 5,
    geojson: "https://raw.githubusercontent.com/isellsoap/deutschlandGeoJSON/main/2_bundeslaender/4_niedrig.geo.json",
    /* GeoJSON feature .properties.name (German) -> dashboard English state name */
    nameMap: {
      "Baden-Württemberg":"Baden-Württemberg","Bayern":"Bavaria","Berlin":"Berlin",
      "Brandenburg":"Brandenburg","Bremen":"Bremen","Hamburg":"Hamburg","Hessen":"Hesse",
      "Niedersachsen":"Lower Saxony","Mecklenburg-Vorpommern":"Mecklenburg-Vorpommern",
      "Nordrhein-Westfalen":"North Rhine-Westphalia","Rheinland-Pfalz":"Rhineland-Palatinate",
      "Saarland":"Saarland","Sachsen":"Saxony","Sachsen-Anhalt":"Saxony-Anhalt",
      "Schleswig-Holstein":"Schleswig-Holstein","Thüringen":"Thuringia"
    }
  }
};
function regionFor(sector) { return REGIONS[sector.region || "germany"] || REGIONS.germany; }

/* Shared employer-sector (ISIC) colour map. Unknown sectors fall back to teal. */
const ISIC_COLORS = {
  "Residential & Long-term Care":"#1A7B7A","Medical & Dental Practice":"#D4940A",
  "Other Health Services & Industry":"#2D9B9A","Hospitals & Acute Care":"#E8A820",
  "Staffing & Recruitment":"#0F5B5A","Mental Health & Rehabilitation":"#B8D9D9"
};

function csvUrlFor(sector) { return CSV_BASE + sector.csv; }
function getSector(id) { return SECTORS.find(function (s) { return s.id === id; }) || null; }
