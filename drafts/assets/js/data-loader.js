/* ============================================================================
   DATA LOADER  —  builds the full in-browser DATA model from a sector CSV.
   ----------------------------------------------------------------------------
   Loading is done with an explicit fetch() (NOT PapaParse download:true) so we
   can:
     • check the real HTTP status (404 = file not at that path in the repo),
     • strip a UTF-8 BOM (Excel-exported CSVs add one; it corrupts the first
       header name and silently drops every row),
     • auto-detect a ',' vs ';' delimiter (German exports often use ';'),
     • match column names case-/format-insensitively (Job_Title == job title),
   and hand back precise diagnostics instead of a misleading "test locally"
   message. The aggregation core is unchanged and still emits the structures the
   render engine consumes, PLUS ISCO-4 codes and per-code classification tables.

     DATA = {
       lookup:  { states[], isic[], isco4[], empTypes[], weekLabels[] },
       rows:    [[state, isic, isco2, isco3, isco4, emp, genuine, week], ...],
       raw:     { title[], date[], company[], empCat[], salary[], desc[], req[],
                  benefits[], workType[], url[] },                     // by row idx
       meta:    { total, dateRange, weeks, scraped, clinical, cols[] },
       roleGroups:   [ {code, name, color}, ... ],   // top ISCO-3, drives sub-tabs
       roleTable:    [ {isco3, name, count, ptPct, topEmp, topState}, ... ],
       isco3Table:   [ {code, name, count, pct}, ... ],            // ALL ISCO-3
       isco4Table:   [ {code, name, isco3, count, pct}, ... ],     // ALL ISCO-4
       stateGeo:     { <State>: {hc, topRoles[], topEmp}, ... },
       companies:    { <isco3>: [ {name, count, isic}, ... ] },
       companiesAll: [ {name, count, isic}, ... ],
       sectorEmployers:{ <isco3>: { <sector>: [ {name, count}, ... ] } },
       isco4CodeByName:{ <isco4 name>: <numeric code> }
     }

   Row encoding:
     r[0] state idx  r[1] employer idx  r[2] ISCO_2  r[3] ISCO_3
     r[4] isco4-name idx  r[5] employment idx  r[6] genuine  r[7] week
   ============================================================================ */

var EMP_ORDER = ["Full-time", "Part-time", "Not specified", "Full-time or Part-time"];
var ROLE_PALETTE = ["#1A7B7A", "#2D9B9A", "#D4940A", "#0F5B5A", "#E8A820", "#4AABAA"];

/* ---- column matching: normalise header + candidate names identically ------ */
function keyNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function normaliseRow(row) {
  var out = {};
  for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) out[keyNorm(k)] = row[k];
  return out;
}
function pick(nrow, names) {
  for (var i = 0; i < names.length; i++) {
    var v = nrow[keyNorm(names[i])];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDay(d) { return MONTHS[d.getMonth()] + " " + d.getDate(); }
function startOfWeek(d) { var x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; }

/* ---- delimiter sniff: compare ',' vs ';' vs '\t' counts on the header ------ */
function sniffDelimiter(text) {
  var nl = text.indexOf("\n");
  var head = nl >= 0 ? text.slice(0, nl) : text;
  var counts = { ",": (head.match(/,/g) || []).length,
                 ";": (head.match(/;/g) || []).length,
                 "\t": (head.match(/\t/g) || []).length };
  var best = ",", n = -1;
  for (var d in counts) if (counts[d] > n) { n = counts[d]; best = d; }
  return n > 0 ? best : ",";
}

/* ---- typed load error carrying diagnostics for the UI --------------------- */
function LoadError(kind, message, diag) {
  var e = new Error(message); e.kind = kind; e.diag = diag || {}; return e;
}

/* ============================================================================
   loadSectorData(sectorId) -> Promise<DATA>
   ============================================================================ */
function loadSectorData(sectorId) {
  var sector = (typeof getSector === "function") ? getSector(sectorId) : { csv: "data/" + sectorId + ".csv" };
  var url = (typeof csvUrlFor === "function") ? csvUrlFor(sector) : sector.csv;

  return fetch(url, { cache: "no-store" }).then(function (res) {
    if (!res.ok) {
      throw LoadError("http",
        "HTTP " + res.status + " fetching " + url,
        { url: url, status: res.status });
    }
    return res.text();
  }).then(function (text) {
    if (!text || !text.trim()) throw LoadError("empty", "The file is empty.", { url: url, bytes: 0 });
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);            // strip BOM

    /* If the server handed us an HTML 404 page (misconfigured host), catch it. */
    var lead = text.slice(0, 200).toLowerCase();
    if (lead.indexOf("<!doctype html") === 0 || lead.indexOf("<html") === 0) {
      throw LoadError("http", "Received an HTML page instead of CSV (likely a 404).",
        { url: url, status: 404, bytes: text.length });
    }

    var delim = sniffDelimiter(text);
    var parsed = Papa.parse(text, { header: true, skipEmptyLines: true, delimiter: delim });
    var rows = parsed.data || [];
    var headers = (parsed.meta && parsed.meta.fields) || (rows[0] ? Object.keys(rows[0]) : []);

    var built = buildDATA(rows, { url: url, delimiter: delim, bytes: text.length, headers: headers });
    if (!built.rows.length) {
      /* Parsed fine but nothing survived the in-scope/classified filter — tell
         the user exactly which required columns are missing (if any).          */
      var need = ["ISCO_4", "ISCO_3", "ISCO_2", "ISCO_4_name", "State", "Employer_Category"];
      var have = headers.map(keyNorm);
      var missing = need.filter(function (c) { return have.indexOf(keyNorm(c)) === -1; });
      throw LoadError("empty",
        "The CSV parsed (" + rows.length + " rows, delimiter '" + delim + "'), but no rows " +
        "survived classification.",
        { url: url, delimiter: delim, bytes: text.length, headers: headers,
          missing: missing, parsedRows: rows.length });
    }
    return built;
  });
}

/* ============================================================================
   buildDATA(rawRows, diag) -> DATA
   ============================================================================ */
function buildDATA(rawRows, diag) {
  diag = diag || {};

  /* 1. Normalise + keep in-scope, classified postings; preserve raw columns. */
  var recs = [];
  rawRows.forEach(function (raw0) {
    var row = normaliseRow(raw0);
    var scope = pick(row, ["Scope_Category"]);
    var cat   = pick(row, ["Job_Category"]);
    var isco4code = pick(row, ["ISCO_4", "ISCO_Code", "ISCO4"]);
    if (scope === "Out of Scope") return;
    if (cat === "Out of Scope" || cat === "CLASSIFICATION_FAILED") return;
    if (!isco4code) return;

    var dRaw = pick(row, ["Date_Posted", "Date_Scraped"]);
    var d = dRaw ? new Date(dRaw) : null;
    if (d && isNaN(d.getTime())) d = null;

    var desc = pick(row, ["Description"]);
    var req  = pick(row, ["Requirements"]);
    var ben  = pick(row, ["Benefits"]);

    recs.push({
      state:    pick(row, ["State", "Bundesland", "Region"]) || "",
      isic:     pick(row, ["Employer_Sector", "Employer_Category", "Employer_Type", "ISIC"]) || "Not specified",
      isco2:    parseInt(pick(row, ["ISCO_2", "ISCO2"]), 10),
      isco3:    parseInt(pick(row, ["ISCO_3", "ISCO3"]), 10),
      isco4code:parseInt(isco4code, 10),
      isco4nm:  pick(row, ["ISCO_4_name", "ISCO_Occupation_Title", "ISCO_4_Name", "Occupation"]) || ("ISCO " + isco4code),
      emp:      pick(row, ["Employment_type", "Employment_Type", "Contract_Type"]) || "Not specified",
      date:     d,
      dateStr:  dRaw || "",
      company:  pick(row, ["Company_Name", "Company", "Employer"]) || "—",
      title:    pick(row, ["Job_Title", "Title"]) || "—",
      empCat:   pick(row, ["Employer_Category", "Employer_Type"]) || "",
      salary:   pick(row, ["Salary", "Pay", "Compensation"]) || "",
      desc:     desc || "",
      req:      req || "",
      benefits: ben || "",
      workType: pick(row, ["Work_Type", "Workplace", "Remote"]) || "",
      url:      pick(row, ["Job_URL", "URL", "Link", "Company_URL"]) || ""
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

  /* map ISCO-4 name -> its numeric code (first seen wins). */
  var isco4CodeByName = {};
  recs.forEach(function (r) { if (!(r.isco4nm in isco4CodeByName) && !isNaN(r.isco4code)) isco4CodeByName[r.isco4nm] = r.isco4code; });

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
  var byState = {}, byRole = {}, byIsco3 = {}, byIsco4 = {};
  var coRole = {}, coSec = {}, coAll = {};

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

    if (r.state) {
      var g = byState[r.state] || (byState[r.state] = { count: 0, roles: {}, emps: {} });
      g.count++; g.roles[r.isco4nm] = (g.roles[r.isco4nm] || 0) + 1; g.emps[r.isic] = (g.emps[r.isic] || 0) + 1;
    }
    if (!isNaN(r.isco3)) {
      var code = r.isco3;
      var rg = byRole[code] || (byRole[code] = { count: 0, names: {}, emps: {}, states: {}, pt: 0 });
      rg.count++; rg.names[r.isco4nm] = (rg.names[r.isco4nm] || 0) + 1;
      rg.emps[r.isic] = (rg.emps[r.isic] || 0) + 1;
      if (r.state) rg.states[r.state] = (rg.states[r.state] || 0) + 1;
      if (isPartTime(r.emp)) rg.pt++;

      byIsco3[code] = byIsco3[code] || { count: 0, names: {} };
      byIsco3[code].count++; byIsco3[code].names[r.isco4nm] = (byIsco3[code].names[r.isco4nm] || 0) + 1;

      var cr = coRole[code] || (coRole[code] = {});
      var e = cr[r.company] || (cr[r.company] = { count: 0, isic: r.isic }); e.count++;
      var cs = coSec[code] || (coSec[code] = {});
      var ss = cs[r.isic] || (cs[r.isic] = {}); ss[r.company] = (ss[r.company] || 0) + 1;
    }
    if (!isNaN(r.isco4code)) {
      var k4 = r.isco4code;
      byIsco4[k4] = byIsco4[k4] || { count: 0, name: r.isco4nm, isco3: r.isco3 };
      byIsco4[k4].count++;
    }
    var ca = coAll[r.company] || (coAll[r.company] = { count: 0, isic: r.isic }); ca.count++;

  });

  /* 5. roleTable / roleGroups. */
  var roleTable = Object.keys(byRole).map(function (code) {
    var rg = byRole[code];
    return { isco3: parseInt(code, 10), name: topKey(rg.names) || ("ISCO " + code), count: rg.count,
             ptPct: rg.count ? +(rg.pt / rg.count * 100).toFixed(1) : 0,
             topEmp: topKey(rg.emps) || "—", topState: topKey(rg.states) || "—" };
  }).sort(function (a, b) { return b.count - a.count; });

  var roleGroups = roleTable.slice(0, 6).map(function (r, i) {
    return { code: r.isco3, name: (typeof ISCO3_NAMES !== "undefined" && ISCO3_NAMES[r.isco3]) || r.name,
             color: ROLE_PALETTE[i % ROLE_PALETTE.length] };
  });

  var totalN = rows.length;
  /* ALL ISCO-3 (not just top 6) as a standalone classification table. */
  var isco3Table = Object.keys(byIsco3).map(function (code) {
    var c = parseInt(code, 10);
    return { code: c, name: (typeof ISCO3_NAMES !== "undefined" && ISCO3_NAMES[c]) || topKey(byIsco3[code].names) || ("ISCO " + c),
             count: byIsco3[code].count, pct: totalN ? +(byIsco3[code].count / totalN * 100).toFixed(1) : 0 };
  }).sort(function (a, b) { return b.count - a.count; });

  /* ALL ISCO-4 as a standalone classification table. */
  var isco4Table = Object.keys(byIsco4).map(function (code) {
    var c = parseInt(code, 10);
    return { code: c, name: byIsco4[code].name, isco3: byIsco4[code].isco3,
             count: byIsco4[code].count, pct: totalN ? +(byIsco4[code].count / totalN * 100).toFixed(1) : 0 };
  }).sort(function (a, b) { return b.count - a.count; });

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
    rows: rows, raw: raw,
    meta: { total: rows.length, dateRange: dateRange, weeks: weekLabels.length,
            scraped: rawRows.length, clinical: rows.length,
            cols: diag.headers || [] },
    roleGroups: roleGroups, roleTable: roleTable,
    isco3Table: isco3Table, isco4Table: isco4Table,
    stateGeo: stateGeo, companies: companies, companiesAll: companiesAll,
    sectorEmployers: sectorEmployers,
    isco4CodeByName: isco4CodeByName
  };
}

/* ---- helpers -------------------------------------------------------------- */
function isPartTime(label) { return label === "Part-time" || label === "Full-time or Part-time"; }
var ISCO3_NAMES = {
  221:"Medical Doctors", 222:"Nursing and Midwifery Professionals",
  226:"Allied Health Professionals", 321:"Medical and Pharmaceutical Technicians",
  322:"Nursing and Midwifery Associates", 325:"Health Associate Professionals",
  531:"Child Care Workers", 532:"Personal Care Workers",
  134:"Health Service Managers",
  /* hospitality */
  141:"Hotel and Restaurant Managers", 143:"Other Services Managers",
  343:"Artistic, Culinary & Related Associates",
  512:"Cooks", 513:"Waiters and Bartenders", 514:"Hairdressers & Beauticians",
  515:"Cleaning & Housekeeping Supervisors", 911:"Domestic & Office Cleaners", 941:"Food Preparation Assistants",
  /* logistics */
  432:"Material-Recording & Transport Clerks", 833:"Heavy Truck & Bus Drivers",
  834:"Mobile Plant Operators", 933:"Transport & Storage Labourers",
  962:"Other Elementary Workers", 815:"Machine Operators",
  /* construction */
  711:"Building Frame & Related Trades", 712:"Building Finishers",
  713:"Painters & Structure Cleaners", 721:"Sheet & Structural Metal Workers",
  741:"Electrical Equipment Installers", 931:"Mining & Construction Labourers"
};

function uniqueSorted(arr) { return Array.from(new Set(arr)).sort(); }
function uniqueByFreq(arr) { var c = {}; arr.forEach(function (v) { c[v] = (c[v] || 0) + 1; });
  return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }); }
function indexMap(arr) { var m = {}; arr.forEach(function (v, i) { m[v] = i; }); return m; }
function topKey(obj) { var best = null, n = -1; for (var k in obj) if (obj[k] > n) { n = obj[k]; best = k; } return best; }
function topKeys(obj, k) { return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, k); }
