/* ============================================================================
   DATA LOADER
   ----------------------------------------------------------------------------
   >>> THE CSV IS FETCHED HERE <<<  (see loadSectorData -> fetch(url))
   The URL comes from csvUrlFor(sector) in assets/js/sectors.js.

   This module reproduces — in the browser — the same "build step" that used to
   run offline. It reads the clean sector CSV and returns the SAME `DATA` shape
   the dashboard has always consumed, so none of the render code or its
   variables/structures change:

     DATA = {
       lookup: { states[], isic[], isco4[], empTypes[], weekLabels[] },
       rows:   [[stateIdx, isicIdx, ISCO_2, ISCO_3, isco4Idx, empIdx, genuine, weekIdx], ...],
       meta:   { total, dateRange, weeks },
       roleTable: [ {isco3, name, count, ptPct, topEmp, topState}, ... ],
       stateGeo:  { <State>: {count, topRoles[], topEmp}, ... },
       companies: [ {name, count}, ... ]
     }

   Row encoding matches the original dashboard exactly:
     r[0] state index   -> lookup.states  (-1 = unknown)
     r[1] sector index  -> lookup.isic    (employer category)
     r[2] ISCO_2 (raw 2-digit)
     r[3] ISCO_3 (raw 3-digit)
     r[4] occupation index -> lookup.isco4 (ISCO_4 name)
     r[5] employment index -> lookup.empTypes
     r[6] genuine flag  (1 = duplicate repost, hidden when "genuine only" is on)
     r[7] week index    -> lookup.weekLabels  (-1 = undated)
   ============================================================================ */

/* Column names we read from the clean CSV (tolerant to a few aliases). */
function pick(row, names) {
  for (var i = 0; i < names.length; i++) {
    if (row[names[i]] !== undefined && row[names[i]] !== null && String(row[names[i]]).trim() !== "") {
      return String(row[names[i]]).trim();
    }
  }
  return "";
}

var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDay(d) { return MONTHS[d.getMonth()] + " " + d.getDate(); }
function startOfWeek(d) { var x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday-based

/* Main entry — returns a Promise<DATA>. */
function loadSectorData(sector) {
  var url = csvUrlFor(sector); // <-- from sectors.js
  return new Promise(function (resolve, reject) {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: function (res) {
        try { resolve(buildDATA(res.data)); }
        catch (e) { reject(e); }
      },
      error: function (err) { reject(err); }
    });
  });
}

/* Turn parsed CSV rows into the DATA model. */
function buildDATA(raw) {
  // 1. Normalise each posting; keep only in-scope, classified rows.
  var recs = [];
  raw.forEach(function (row) {
    var scope = pick(row, ["Scope_Category"]);
    var cat   = pick(row, ["Job_Category"]);
    var isco4 = pick(row, ["ISCO_4"]);
    // Drop out-of-scope / failed / unclassified rows from the analysis set.
    if (scope === "Out of Scope") return;
    if (cat === "Out of Scope" || cat === "CLASSIFICATION_FAILED") return;
    if (!isco4) return;

    var dRaw = pick(row, ["Date_Posted", "Date_Scraped"]);
    var d = dRaw ? new Date(dRaw) : null;
    if (d && isNaN(d.getTime())) d = null;

    recs.push({
      state:   pick(row, ["State"]) || "",
      isic:    pick(row, ["Employer_Category"]) || "Not specified",
      isco2:   parseInt(pick(row, ["ISCO_2"]), 10),
      isco3:   parseInt(pick(row, ["ISCO_3"]), 10),
      isco4nm: pick(row, ["ISCO_4_name"]) || pick(row, ["ISCO_Occupation_Title"]) || ("ISCO " + isco4),
      emp:     pick(row, ["Employment_type"]) || "Not specified",
      date:    d,
      company: pick(row, ["Company_Name"]) || "—",
      title:   pick(row, ["Job_Title"]) || "—",
      url:     pick(row, ["Job_URL"]) || ""
    });
  });

  // 2. Build lookups.
  var states  = uniqueSorted(recs.map(function (r) { return r.state; }).filter(Boolean));
  var isic    = uniqueByFreq(recs.map(function (r) { return r.isic; }));
  var isco4   = uniqueByFreq(recs.map(function (r) { return r.isco4nm; }));
  var empSeen = uniqueSorted(recs.map(function (r) { return r.emp; }).filter(Boolean));
  var empOrder = ["Full-time", "Part-time", "Full-time or Part-time", "Not specified"];
  var empTypes = empOrder.filter(function (e) { return empSeen.indexOf(e) !== -1; })
                         .concat(empSeen.filter(function (e) { return empOrder.indexOf(e) === -1; }));

  var stateIx = indexMap(states), isicIx = indexMap(isic), isco4Ix = indexMap(isco4), empIx = indexMap(empTypes);

  // 3. Week buckets from the date range.
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

  // 4. Duplicate-repost flag (same company + same title beyond first occurrence).
  var seen = {};

  // 5. Encode rows + collect aggregates in one pass.
  var rows = [];
  var byState = {}, byRole = {};
  recs.forEach(function (r) {
    var key = (r.company + "|" + r.title).toLowerCase();
    var genuine = seen[key] ? 1 : 0; seen[key] = true;
    r.genuine = genuine; // used by the Explorer table

    rows.push([
      r.state in stateIx ? stateIx[r.state] : -1,
      isicIx[r.isic],
      isNaN(r.isco2) ? 0 : r.isco2,
      isNaN(r.isco3) ? 0 : r.isco3,
      isco4Ix[r.isco4nm],
      empIx[r.emp],
      genuine,
      weekIndexOf(r.date)
    ]);

    // aggregates (count all; the UI can still filter genuine at render time)
    if (r.state) {
      var g = byState[r.state] || (byState[r.state] = { count: 0, roles: {}, emps: {} });
      g.count++; g.roles[r.isco4nm] = (g.roles[r.isco4nm] || 0) + 1; g.emps[r.isic] = (g.emps[r.isic] || 0) + 1;
    }
    if (!isNaN(r.isco3)) {
      var rg = byRole[r.isco3] || (byRole[r.isco3] = { count: 0, names: {}, emps: {}, states: {}, pt: 0 });
      rg.count++; rg.names[r.isco4nm] = (rg.names[r.isco4nm] || 0) + 1;
      rg.emps[r.isic] = (rg.emps[r.isic] || 0) + 1;
      if (r.state) rg.states[r.state] = (rg.states[r.state] || 0) + 1;
      if (r.emp === "Part-time" || r.emp === "Full-time or Part-time") rg.pt++;
    }
  });

  // 6. Shape roleTable, stateGeo, companies.
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

  var stateGeo = {};
  Object.keys(byState).forEach(function (st) {
    var g = byState[st];
    stateGeo[st] = { count: g.count, topRoles: topKeys(g.roles, 3), topEmp: topKey(g.emps) || "—" };
  });

  var companyCounts = {};
  recs.forEach(function (r) { companyCounts[r.company] = (companyCounts[r.company] || 0) + 1; });
  var companies = Object.keys(companyCounts).map(function (n) { return { name: n, count: companyCounts[n] }; })
                        .sort(function (a, b) { return b.count - a.count; });

  var dateRange = dated.length
    ? fmtDay(new Date(Math.min.apply(null, dated))) + " – " + fmtDay(new Date(Math.max.apply(null, dated)))
    : "—";

  return {
    lookup: { states: states, isic: isic, isco4: isco4, empTypes: empTypes, weekLabels: weekLabels },
    rows: rows,
    meta: { total: rows.length, dateRange: dateRange, weeks: weekLabels.length },
    roleTable: roleTable,
    stateGeo: stateGeo,
    companies: companies,
    records: recs
  };
}

/* --- small helpers --- */
function uniqueSorted(arr) { return Array.from(new Set(arr)).sort(); }
function uniqueByFreq(arr) {
  var c = {}; arr.forEach(function (v) { c[v] = (c[v] || 0) + 1; });
  return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; });
}
function indexMap(arr) { var m = {}; arr.forEach(function (v, i) { m[v] = i; }); return m; }
function topKey(obj) { var best = null, n = -1; for (var k in obj) if (obj[k] > n) { n = obj[k]; best = k; } return best; }
function topKeys(obj, k) {
  return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, k);
}
