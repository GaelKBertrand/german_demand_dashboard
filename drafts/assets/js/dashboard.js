/* ============================================================================
   DASHBOARD RENDER LOGIC
   Same structure/variables as the original dashboard:
     APP  — filter + view state
     DATA — { lookup, rows[8-int], meta, roleTable, stateGeo, companies, records }
     getRows() — filters DATA.rows by state / employer sector / genuine
   Everything below reads that model and draws with Plotly + Leaflet.
   ============================================================================ */

var C = { teal:"#0F5B5A", tealDeep:"#08403F", tealSoft:"#E3EFED", gold:"#C4880C",
          ink:"#12302E", muted:"#7A928E", line:"#E4E1D8", teal2:"#2D9B9A" };

var APP = { filterState:"ALL", filterIsic:"ALL", filterGenuine:false,
            activeTab:"overview", map:null, expLimit:60, expQuery:"" };

var DATA = null;

/* 16 German state centroids [lat, lng] — keyed by the English names the
   classifiers emit. Used for the Leaflet bubble map (no GeoJSON needed). */
var STATE_CENTROIDS = {
  "Baden-Württemberg":[48.66,9.35],"Bavaria":[48.79,11.50],"Berlin":[52.52,13.40],
  "Brandenburg":[52.13,13.20],"Bremen":[53.08,8.80],"Hamburg":[53.55,10.00],
  "Hesse":[50.65,9.16],"Lower Saxony":[52.64,9.85],"Mecklenburg-Vorpommern":[53.61,12.43],
  "North Rhine-Westphalia":[51.43,7.55],"Rhineland-Palatinate":[49.91,7.45],"Saarland":[49.38,6.95],
  "Saxony":[51.10,13.20],"Saxony-Anhalt":[51.95,11.69],"Schleswig-Holstein":[54.22,9.70],
  "Thuringia":[50.90,11.03]
};

var PBASE = {
  paper_bgcolor:"rgba(0,0,0,0)", plot_bgcolor:"rgba(0,0,0,0)",
  font:{ family:"'Inter',sans-serif", size:12, color:C.ink },
  margin:{ l:8, r:16, t:6, b:30 }, bargap:0.30,
  xaxis:{ gridcolor:C.line, zeroline:false, tickfont:{size:11}, automargin:true },
  yaxis:{ automargin:true, tickfont:{size:11.5} }
};
var PCFG = { displayModeBar:false, responsive:true };
var fmt = function (n) { return Number(n).toLocaleString("en-US"); };

/* -------- filtering (identical logic to the original getRows) -------- */
function getRows() {
  var si = APP.filterState !== "ALL" ? DATA.lookup.states.indexOf(APP.filterState) : -999;
  var ii = APP.filterIsic  !== "ALL" ? DATA.lookup.isic.indexOf(APP.filterIsic)  : -999;
  return DATA.rows.filter(function (r) {
    if (si !== -999 && r[0] !== si) return false;
    if (ii !== -999 && r[1] !== ii) return false;
    if (APP.filterGenuine && r[6] === 1) return false;
    return true;
  });
}
function countBy(rows, idx) {
  var c = {}; rows.forEach(function (r) { var k = r[idx]; c[k] = (c[k] || 0) + 1; }); return c;
}

/* -------- init -------- */
document.addEventListener("DOMContentLoaded", function () {
  var params = new URLSearchParams(location.search);
  var sector = getSector(params.get("sector"));
  if (!sector) { fail("Unknown sector. Return to the <a href='index.html'>dashboard list</a>."); return; }

  document.title = "GATI · " + sector.label;
  document.getElementById("db-title").textContent = sector.label;
  document.getElementById("db-eyebrow").textContent = "Germany · " + sector.scope;

  showStatus('<div class="spinner"></div>Loading ' + sector.label + ' data…');

  loadSectorData(sector).then(function (data) {
    DATA = data;
    hideStatus();
    if (!DATA.rows.length) { fail("No classified rows found in this CSV yet."); return; }
    populateFilters();
    document.getElementById("db-meta").innerHTML =
      '<span class="chip">' + fmt(DATA.meta.total) + ' postings</span>' +
      '<span class="chip">' + DATA.meta.dateRange + '</span>';
    wireFilters();
    renderAll();
  }).catch(function (err) {
    fail("Couldn't load <code>" + csvUrlFor(sector) + "</code>.<br>" +
         "Make sure the CSV exists at that path (see <code>assets/js/sectors.js</code>).<br>" +
         '<span class="muted" style="font-size:12px">' + (err && err.message ? err.message : err) + "</span>");
  });
});

function populateFilters() {
  var st = document.getElementById("flt-state");
  DATA.lookup.states.forEach(function (s) { st.add(new Option(s, s)); });
  var ic = document.getElementById("flt-isic");
  DATA.lookup.isic.forEach(function (s) { ic.add(new Option(s, s)); });
}
function wireFilters() {
  document.getElementById("flt-state").addEventListener("change", function (e) { APP.filterState = e.target.value; renderAll(); });
  document.getElementById("flt-isic").addEventListener("change", function (e) { APP.filterIsic = e.target.value; renderAll(); });
  document.getElementById("flt-genuine").addEventListener("change", function (e) { APP.filterGenuine = e.target.checked; renderAll(); });
  document.getElementById("exp-search").addEventListener("input", function (e) { APP.expQuery = e.target.value.toLowerCase().trim(); APP.expLimit = 60; renderExplorer(); });
  document.getElementById("exp-more").addEventListener("click", function () { APP.expLimit += 60; renderExplorer(); });
}

/* -------- tabs -------- */
function showTab(id, btn) {
  document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("is-active"); });
  document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("is-active"); });
  document.getElementById("tab-" + id).classList.add("is-active");
  btn.classList.add("is-active");
  APP.activeTab = id;
  var rows = getRows();
  if (id === "roles") renderRoleTable(rows);
  if (id === "regional") { renderStateTable(rows); renderMap(rows); }
  if (id === "explorer") renderExplorer();
}

/* -------- render orchestrator -------- */
function renderAll() {
  var rows = getRows();
  document.getElementById("filter-count").textContent = fmt(rows.length) + " postings";
  updateKPIs(rows);
  renderTop(rows);
  renderIsic(rows);
  renderTrend(rows);
  if (APP.activeTab === "roles") renderRoleTable(rows);
  if (APP.activeTab === "regional") { renderStateTable(rows); renderMap(rows); }
  if (APP.activeTab === "explorer") renderExplorer();
}

/* -------- KPIs -------- */
function updateKPIs(rows) {
  var total = rows.length;
  var occ = countBy(rows, 4);
  var distinct = Object.keys(occ).length;
  var topOccIdx = topKeyNum(occ);
  var topOcc = topOccIdx != null ? DATA.lookup.isco4[topOccIdx] : "—";
  var topOccN = topOccIdx != null ? occ[topOccIdx] : 0;
  var ptSet = {};
  DATA.lookup.empTypes.forEach(function (e, i) { if (e === "Part-time" || e === "Full-time or Part-time") ptSet[i] = 1; });
  var pt = rows.filter(function (r) { return ptSet[r[5]]; }).length;
  var ptPct = total ? Math.round(pt / total * 100) : 0;

  document.getElementById("kpis").innerHTML =
    kpi(fmt(total), "postings in view", "", false) +
    kpi(fmt(distinct), "distinct occupations", "", false) +
    kpi(clip(topOcc, 22), "most-posted occupation", fmt(topOccN) + " postings", true) +
    kpi(ptPct + "%", "part-time or flexible", "", false);
}
function kpi(val, label, sub, gold) {
  return '<div class="kpi' + (gold ? " kpi--gold" : "") + '">' +
    '<div class="kpi__val">' + val + '</div>' +
    '<div class="kpi__label">' + label + '</div>' +
    (sub ? '<div class="kpi__sub">' + sub + '</div>' : "") + '</div>';
}

/* -------- overview charts -------- */
function renderTop(rows) {
  var c = countBy(rows, 4);
  var top = Object.keys(c).map(Number).sort(function (a, b) { return c[b] - c[a]; }).slice(0, 10).reverse();
  var y = top.map(function (i) { return clip(DATA.lookup.isco4[i], 34); });
  var x = top.map(function (i) { return c[i]; });
  var lay = Object.assign({}, PBASE, { xaxis: Object.assign({}, PBASE.xaxis), yaxis: Object.assign({}, PBASE.yaxis) });
  Plotly.react("chart-top", [{
    type:"bar", orientation:"h", x:x, y:y,
    marker:{ color:C.teal }, hovertemplate:"%{y}<br>%{x} postings<extra></extra>"
  }], lay, PCFG);
}
function renderIsic(rows) {
  var c = countBy(rows, 1);
  var keys = Object.keys(c).map(Number).sort(function (a, b) { return c[b] - c[a]; });
  Plotly.react("chart-isic", [{
    type:"bar", x: keys.map(function (i) { return clip(DATA.lookup.isic[i], 22); }),
    y: keys.map(function (i) { return c[i]; }),
    marker:{ color:C.teal2 }, hovertemplate:"%{x}<br>%{y} postings<extra></extra>"
  }], PBASE, PCFG);
}
function renderTrend(rows) {
  var labels = DATA.lookup.weekLabels;
  var y = labels.map(function (_, i) { return rows.filter(function (r) { return r[7] === i; }).length; });
  Plotly.react("chart-trend", [{
    type:"scatter", mode:"lines+markers", x:labels, y:y,
    line:{ color:C.teal, width:2.5, shape:"spline" }, marker:{ color:C.teal, size:6 },
    fill:"tozeroy", fillcolor:"rgba(15,91,90,.07)", hovertemplate:"%{x}<br>%{y} postings<extra></extra>"
  }], PBASE, PCFG);
}

/* -------- roles table (live, respects filters) -------- */
function renderRoleTable(rows) {
  var g = {};
  rows.forEach(function (r) {
    var k = r[3]; var o = g[k] || (g[k] = { count:0, names:{}, emps:{}, states:{}, pt:0 });
    o.count++; o.names[r[4]] = (o.names[r[4]] || 0) + 1; o.emps[r[1]] = (o.emps[r[1]] || 0) + 1;
    if (r[0] >= 0) o.states[r[0]] = (o.states[r[0]] || 0) + 1;
    if (r[5] != null && (DATA.lookup.empTypes[r[5]] === "Part-time" || DATA.lookup.empTypes[r[5]] === "Full-time or Part-time")) o.pt++;
  });
  var list = Object.keys(g).map(function (k) {
    var o = g[k];
    return { isco3:k, name: DATA.lookup.isco4[topKeyNum(o.names)] || ("ISCO " + k),
             count:o.count, ptPct: o.count ? Math.round(o.pt / o.count * 100) : 0,
             topEmp: DATA.lookup.isic[topKeyNum(o.emps)] || "—",
             topState: o.states && topKeyNum(o.states) != null ? DATA.lookup.states[topKeyNum(o.states)] : "—" };
  }).sort(function (a, b) { return b.count - a.count; });

  var html = "<thead><tr><th>ISCO-3</th><th>Occupation group</th><th>Postings</th><th>Part-time</th><th>Top employer sector</th><th>Top state</th></tr></thead><tbody>";
  list.forEach(function (r) {
    html += "<tr><td><span class='chip'>" + r.isco3 + "</span></td><td>" + esc(r.name) +
      "</td><td class='num'>" + fmt(r.count) + "</td><td class='num'>" + r.ptPct + "%</td><td>" +
      esc(r.topEmp) + "</td><td>" + esc(r.topState) + "</td></tr>";
  });
  document.getElementById("role-table").innerHTML = html + "</tbody>";
}

/* -------- regional -------- */
function renderStateTable(rows) {
  var c = countBy(rows, 0); delete c["-1"];
  var keys = Object.keys(c).map(Number).sort(function (a, b) { return c[b] - c[a]; });
  var total = keys.reduce(function (s, k) { return s + c[k]; }, 0) || 1;
  var html = "<thead><tr><th>State</th><th>Postings</th><th>Share</th></tr></thead><tbody>";
  keys.forEach(function (i) {
    html += "<tr><td>" + esc(DATA.lookup.states[i]) + "</td><td class='num'>" + fmt(c[i]) +
      "</td><td class='num'>" + (c[i] / total * 100).toFixed(1) + "%</td></tr>";
  });
  document.getElementById("state-table").innerHTML = html + "</tbody>";
}
function renderMap(rows) {
  if (!APP.map) {
    APP.map = L.map("map", { scrollWheelZoom:false, attributionControl:false }).setView([51.1, 10.3], 5);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom:10 }).addTo(APP.map);
    APP.mapLayer = L.layerGroup().addTo(APP.map);
  }
  APP.mapLayer.clearLayers();
  var c = countBy(rows, 0); delete c["-1"];
  var max = Math.max.apply(null, Object.keys(c).map(function (k) { return c[k]; }).concat([1]));
  Object.keys(c).forEach(function (i) {
    var name = DATA.lookup.states[i], ll = STATE_CENTROIDS[name]; if (!ll) return;
    var radius = 8 + 26 * Math.sqrt(c[i] / max);
    L.circleMarker(ll, { radius:radius, color:C.tealDeep, weight:1, fillColor:C.teal, fillOpacity:.55 })
      .bindTooltip("<b>" + name + "</b><br>" + fmt(c[i]) + " postings", { direction:"top" })
      .addTo(APP.mapLayer);
  });
  setTimeout(function () { APP.map.invalidateSize(); }, 60);
}

/* -------- explorer (uses DATA.records for human-readable detail) -------- */
function renderExplorer() {
  var recs = DATA.records.filter(function (r) {
    if (APP.filterState !== "ALL" && r.state !== APP.filterState) return false;
    if (APP.filterIsic !== "ALL" && r.isic !== APP.filterIsic) return false;
    if (APP.filterGenuine && r.genuine === 1) return false;
    if (APP.expQuery && (r.title + " " + r.company + " " + r.isco4nm).toLowerCase().indexOf(APP.expQuery) === -1) return false;
    return true;
  });
  var shown = recs.slice(0, APP.expLimit);
  var html = "<thead><tr><th>Job title</th><th>Occupation</th><th>Employer sector</th><th>State</th><th></th></tr></thead><tbody>";
  shown.forEach(function (r) {
    html += "<tr><td>" + esc(clip(r.title, 60)) + "<div class='muted' style='font-size:11.5px'>" + esc(r.company) + "</div></td><td>" +
      esc(r.isco4nm) + "</td><td>" + esc(r.isic) + "</td><td>" + esc(r.state || "—") + "</td><td>" +
      (r.url ? "<a href='" + esc(r.url) + "' target='_blank' rel='noopener'>view &rarr;</a>" : "") + "</td></tr>";
  });
  document.getElementById("exp-table").innerHTML = html + "</tbody>";
  document.getElementById("exp-more").style.display = recs.length > APP.expLimit ? "" : "none";
}

/* -------- helpers -------- */
function topKeyNum(obj) { var best = null, n = -1; for (var k in obj) if (obj[k] > n) { n = obj[k]; best = +k; } return best; }
function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]; }); }
function showStatus(html) { var el = document.getElementById("db-status"); el.className = "db-status"; el.innerHTML = html; el.hidden = false; }
function fail(html) { var el = document.getElementById("db-status"); el.className = "db-status is-error"; el.innerHTML = html; el.hidden = false; }
function hideStatus() { document.getElementById("db-status").hidden = true; }
function showTab_export() {}
