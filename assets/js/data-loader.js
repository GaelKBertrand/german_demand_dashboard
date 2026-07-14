/* ============================================================================
   DATA LOADER  —  builds the full in-browser DATA model from a sector CSV.
   ----------------------------------------------------------------------------
   >>> THE CSV IS FETCHED HERE <<<  (loadSectorData -> Papa.parse(url))
   The URL comes from csvUrlFor(sector) in assets/js/sectors.js.

   This reproduces — client-side — the "build step" that used to run offline for
   the original single-file healthcare dashboard, and emits the SAME structures
   its render engine consumed, PLUS the raw column arrays the Data Explorer and
   Role deep-dives need. Nothing about the encoding changed, so the render code
   is a faithful port of the original.

     DATA = {
       lookup:  { states[], isic[], isco4[], empTypes[], weekLabels[] },
       rows:    [[state, isic, isco2, isco3, isco4, emp, genuine, week], ...],
       raw:     { title[], date[], company[], empCat[], salary[],
                  desc[], req[], benefits[], workType[], url[] },   // by row index
       meta:    { total, dateRange, weeks, scraped, clinical },
       roleGroups:      [ {code, name, color}, ... ],   // top ISCO-3, drives sub-tabs
       roleTable:       [ {isco3, name, count, ptPct, topEmp, topState}, ... ],
       stateGeo:        { <State>: {hc, topRoles[], topEmp}, ... },
       companies:       { <isco3>: [ {name, count, isic}, ... ] },  // per role
       companiesAll:    [ {name, count, isic}, ... ],
       sectorEmployers: { <isco3>: { <sector>: [ {name, count}, ... ] } }
     }

   Row encoding (identical to the original dashboard):
     r[0] state index    -> lookup.states   (-1 unknown)
     r[1] employer index -> lookup.isic     (ISIC employer category)
     r[2] ISCO_2 (raw 2-digit)
     r[3] ISCO_3 (raw 3-digit)
     r[4] occupation idx -> lookup.isco4    (ISCO_4 name)
     r[5] employment idx -> lookup.empTypes (canonical order below)
     r[6] genuine flag   (1 = duplicate repost, hidden when "genuine only" is on)
     r[7] week index     -> lookup.weekLabels (-1 undated)
   ============================================================================ */

/* Canonical employment order so part-time detection is stable across sectors.
   Part-time-ish = "Part-time" and "Full-time or Part-time" (see PT_LABELS in
   dashboard.js). Any unseen label is appended after these.                    */
var EMP_ORDER = ["Full-time", "Part-time", "Not specified", "Full-time or Part-time"];

/* Colour palette assigned to the derived role groups (max 6). */
var ROLE_PALETTE = ["#1A7B7A", "#2D9B9A", "#D4940A", "#0F5B5A", "#E8A820", "#4AABAA"];

function pick(row, names) {
  for (var i = 0; i < names.length; i++) {
    var v = row[names[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDay(d) { return MONTHS[d.getMonth()] + " " + d.getDate(); }
function startOfWeek(d) { var x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; }

function loadSectorData(sector) {
  var url = csvUrlFor(sector);
  return new Promise(function (resolve, reject) {
    Papa.parse(url, {
      download: true, header: true, skipEmptyLines: true,
      complete: function (res) { try { resolve(buildDATA(res.data)); } catch (e) { reject(e); } },
      error: function (err) { reject(err); }
    });
  });
}

function buildDATA(rawRows) {
  /* 1. Normalise + keep in-scope, classified postings. Preserve raw text cols. */
  var recs = [];
  rawRows.forEach(function (row) {
    var scope = pick(row, ["Scope_Category"]);
    var cat   = pick(row, ["Job_Category"]);
    var isco4 = pick(row, ["ISCO_4", "ISCO_Code"]);
    if (scope === "Out of Scope") return;
    if (cat === "Out of Scope" || cat === "CLASSIFICATION_FAILED") return;
    if (!isco4) return;

    var dRaw = pick(row, ["Date_Posted", "Date_Scraped"]);
    var d = dRaw ? new Date(dRaw) : null;
    if (d && isNaN(d.getTime())) d = null;

    recs.push({
      state:    pick(row, ["State"]) || "",
      isic:     pick(row, ["Employer_Category"]) || "Not specified",
      isco2:    parseInt(pick(row, ["ISCO_2"]), 10),
      isco3:    parseInt(pick(row, ["ISCO_3"]), 10),
      isco4nm:  pick(row, ["ISCO_4_name", "ISCO_Occupation_Title"]) || ("ISCO " + isco4),
      emp:      pick(row, ["Employment_type"]) || "Not specified",
      date:     d,
      dateStr:  dRaw || "",
      company:  pick(row, ["Company_Name"]) || "—",
      title:    pick(row, ["Job_Title"]) || "—",
      empCat:   pick(row, ["Employer_Category"]) || "",
      salary:   pick(row, ["Salary"]) || "",
      desc:     pick(row, ["Description"]) || "",
      req:      pick(row, ["Requirements"]) || "",
      benefits: pick(row, ["Benefits"]) || "",
      workType: pick(row, ["Work_Type"]) || "",
      url:      pick(row, ["Job_URL", "Company_URL"]) || ""
    });
  });

  /* 2. Lookups. */
  var states  = uniqueSorted(recs.map(function (r) { return r.state; }).filter(Boolean));
  var isic    = uniqueByFreq(recs.map(function (r) { return r.isic; }));
  var isco4   = uniqueByFreq(recs.map(function (r) { return r.isco4nm; }));
  var empSeen = uniqueSorted(recs.map(function (r) { return r.emp; }).filter(Boolean));
  var empTypes = EMP_ORDER.filter(function (e) { return empSeen.indexOf(e) !== -1; })
                          .concat(empSeen.filter(function (e) { return EMP_ORDER.indexOf(e) === -1; }));
  if (empTypes.length === 0) empTypes = ["Not specified"];

  var stateIx = indexMap(states), isicIx = indexMap(isic),
      isco4Ix = indexMap(isco4), empIx = indexMap(empTypes);

  /* 3. Week buckets. */
  var dated = recs.map(function (r) { return r.date; }).filter(Boolean);
  var weekStarts = [], weekLabels = [], minWk = null;
  if (dated.length) {
    var minD = new Date(Math.min.apply(null, dated)), maxD = new Date(Math.max.apply(null, dated));
    minWk = startOfWeek(minD);
    var w = new Date(minWk);
    while (w <= maxD) { weekStarts.push(new Date(w)); weekLabels.push(fmtDay(w)); w.setDate(w.getDate() + 7); }
  }
  function weekIndexOf(d) {
    if (!d || !minWk) return -1;
    var idx = Math.floor((startOfWeek(d) - minWk) / (7 * 86400000));
    return (idx >= 0 && idx < weekStarts.length) ? idx : -1;
  }

  /* 4. Encode rows + raw arrays + aggregates in one pass. */
  var rows = [];
  var raw = { title: [], date: [], company: [], empCat: [], salary: [],
              desc: [], req: [], benefits: [], workType: [], url: [] };
  var seen = {};
  var byState = {}, byRole = {};
  var coRole = {};   // isco3 -> company -> {count, isic}
  var coSec  = {};   // isco3 -> sector -> company -> count
  var coAll  = {};   // company -> {count, isic}

  recs.forEach(function (r) {
    var key = (r.company + "|" + r.title).toLowerCase();
    var genuine = seen[key] ? 1 : 0; seen[key] = true;

    rows.push([
      (r.state in stateIx) ? stateIx[r.state] : -1,
      isicIx[r.isic],
      isNaN(r.isco2) ? 0 : r.isco2,
      isNaN(r.isco3) ? 0 : r.isco3,
      isco4Ix[r.isco4nm],
      empIx[r.emp],
      genuine,
      weekIndexOf(r.date)
    ]);

    raw.title.push(r.title);     raw.date.push(r.dateStr);   raw.company.push(r.company);
    raw.empCat.push(r.empCat);   raw.salary.push(r.salary);  raw.desc.push(r.desc);
    raw.req.push(r.req);         raw.benefits.push(r.benefits);
    raw.workType.push(r.workType); raw.url.push(r.url);

    /* state aggregate */
    if (r.state) {
      var g = byState[r.state] || (byState[r.state] = { count: 0, roles: {}, emps: {} });
      g.count++; g.roles[r.isco4nm] = (g.roles[r.isco4nm] || 0) + 1; g.emps[r.isic] = (g.emps[r.isic] || 0) + 1;
    }
    /* role aggregate */
    if (!isNaN(r.isco3)) {
      var code = r.isco3;
      var rg = byRole[code] || (byRole[code] = { count: 0, names: {}, emps: {}, states: {}, pt: 0 });
      rg.count++; rg.names[r.isco4nm] = (rg.names[r.isco4nm] || 0) + 1;
      rg.emps[r.isic] = (rg.emps[r.isic] || 0) + 1;
      if (r.state) rg.states[r.state] = (rg.states[r.state] || 0) + 1;
      if (isPartTime(r.emp)) rg.pt++;

      /* top companies per role */
      var cr = coRole[code] || (coRole[code] = {});
      var e = cr[r.company] || (cr[r.company] = { count: 0, isic: r.isic });
      e.count++;
      /* top employers per (role, sector) */
      var cs = coSec[code] || (coSec[code] = {});
      var ss = cs[r.isic] || (cs[r.isic] = {});
      ss[r.company] = (ss[r.company] || 0) + 1;
    }
    /* global companies */
    var ca = coAll[r.company] || (coAll[r.company] = { count: 0, isic: r.isic });
    ca.count++;
  });

  /* 5. roleTable / roleGroups. */
  var roleTable = Object.keys(byRole).map(function (code) {
    var rg = byRole[code];
    return {
      isco3: parseInt(code, 10),
      name: topKey(rg.names) || ("ISCO " + code),
      count: rg.count,
      ptPct: rg.count ? +(rg.pt / rg.count * 100).toFixed(1) : 0,
      topEmp: topKey(rg.emps) || "—",
      topState: topKey(rg.states) || "—"
    };
  }).sort(function (a, b) { return b.count - a.count; });

  /* Role groups that drive sub-tabs + cross-tab: top up-to-6 ISCO-3 by volume.
     Uses a friendly ISCO-3 name when known, else the dominant occupation name.  */
  var roleGroups = roleTable.slice(0, 6).map(function (r, i) {
    return { code: r.isco3, name: ISCO3_NAMES[r.isco3] || r.name, color: ROLE_PALETTE[i % ROLE_PALETTE.length] };
  });

  /* 6. stateGeo. */
  var stateGeo = {};
  Object.keys(byState).forEach(function (st) {
    var g = byState[st];
    stateGeo[st] = { hc: g.count, topRoles: topKeys(g.roles, 3), topEmp: topKey(g.emps) || "—" };
  });

  /* 7. companies per role + global. */
  var companies = {};
  Object.keys(coRole).forEach(function (code) {
    companies[code] = Object.keys(coRole[code]).map(function (n) {
      return { name: n, count: coRole[code][n].count, isic: coRole[code][n].isic };
    }).filter(function (c) { return c.name && c.name !== "—"; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 15);
  });
  var companiesAll = Object.keys(coAll).map(function (n) {
    return { name: n, count: coAll[n].count, isic: coAll[n].isic };
  }).sort(function (a, b) { return b.count - a.count; });

  /* 8. sectorEmployers: per role -> per sector -> top 3 employers. */
  var sectorEmployers = {};
  Object.keys(coSec).forEach(function (code) {
    var out = {};
    Object.keys(coSec[code]).forEach(function (sector) {
      out[sector] = Object.keys(coSec[code][sector]).map(function (n) {
        return { name: n, count: coSec[code][sector][n] };
      }).filter(function (c) { return c.name && c.name !== "—"; })
        .sort(function (a, b) { return b.count - a.count; }).slice(0, 3);
    });
    sectorEmployers[code] = out;
  });

  var dateRange = dated.length
    ? fmtDay(new Date(Math.min.apply(null, dated))) + " – " + fmtDay(new Date(Math.max.apply(null, dated)))
    : "—";

  return {
    lookup: { states: states, isic: isic, isco4: isco4, empTypes: empTypes, weekLabels: weekLabels },
    rows: rows,
    raw: raw,
    meta: { total: rows.length, dateRange: dateRange, weeks: weekLabels.length,
            scraped: rawRows.length, clinical: rows.length },
    roleGroups: roleGroups,
    roleTable: roleTable,
    stateGeo: stateGeo,
    companies: companies,
    companiesAll: companiesAll,
    sectorEmployers: sectorEmployers
  };
}

/* part-time-ish detector (label-based, robust to lookup ordering). */
function isPartTime(label) { return label === "Part-time" || label === "Full-time or Part-time"; }

/* ISCO-3 friendly names (extend as needed; unknown codes fall back to data). */
var ISCO3_NAMES = {
  221:"Medical Doctors", 222:"Nursing and Midwifery Professionals",
  226:"Allied Health Professionals", 321:"Medical and Pharmaceutical Technicians",
  322:"Nursing and Midwifery Associates", 325:"Health Associate Professionals",
  531:"Child Care Workers", 532:"Personal Care Workers",
  /* hospitality */
  141:"Hotel and Restaurant Managers", 343:"Artistic & Culinary Associates",
  512:"Cooks", 513:"Waiters and Bartenders", 514:"Hairdressers & Beauticians",
  515:"Cleaning & Housekeeping Supervisors", 911:"Cleaners and Helpers",
  /* logistics */
  432:"Material-Recording & Transport Clerks", 833:"Heavy Truck & Bus Drivers",
  834:"Mobile Plant Operators", 933:"Transport & Storage Labourers",
  962:"Other Elementary Workers", 815:"Machine Operators",
  /* construction */
  711:"Building Frame & Related Trades", 712:"Building Finishers",
  713:"Painters & Structure Cleaners", 721:"Sheet & Structural Metal Workers",
  741:"Electrical Equipment Installers", 931:"Mining & Construction Labourers"
};

/* helpers */
function uniqueSorted(arr) { return Array.from(new Set(arr)).sort(); }
function uniqueByFreq(arr) { var c = {}; arr.forEach(function (v) { c[v] = (c[v] || 0) + 1; });
  return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }); }
function indexMap(arr) { var m = {}; arr.forEach(function (v, i) { m[v] = i; }); return m; }
function topKey(obj) { var best = null, n = -1; for (var k in obj) if (obj[k] > n) { n = obj[k]; best = k; } return best; }
function topKeys(obj, k) { return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, k); }
