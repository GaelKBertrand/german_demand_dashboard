/* ============================================================================
   CHART KIT — shared chart styling, labelling and export for every chart.
   ----------------------------------------------------------------------------
   Loaded before dashboard.js. It owns:
     • PAL / SEQ / plotBase / plotCfg — one professional palette and one Plotly
       base layout, so every chart in the dashboard looks like the same product.
     • wrapLabel()  — wraps a long axis label across lines at word boundaries.
       Nothing is ever cut off with an ellipsis; the full string is also placed
       in the hover tooltip.
     • drawChart(id, traces, layout, meta) — renders the chart AND attaches the
       export control to it. Every chart in the dashboard goes through this, so
       no chart can ship without a working download button.
     • exportChart(id, fmt) — PNG (2x), SVG (vector), or CSV of the numbers
       actually plotted.
   ============================================================================ */

/* ---- palette ------------------------------------------------------------- *
   Anchored on the GATI brand (deep teal + gold). Ordered so that neighbouring
   series stay distinguishable, including for the most common form of colour
   blindness, and so no chart mixes an off-brand hue.                          */
var PAL = {
  ink:'#0F2E2E', mid:'#3D6060', soft:'#7A9C9C', line:'#DCE9E9', grid:'#EDF4F4',
  teal:'#1A7B7A', tealD:'#0F5B5A', tealDD:'#0A3E3D', tealL:'#5FB3B2', tealLL:'#A9D6D5',
  gold:'#C98A0B', goldL:'#E5B04A', goldD:'#8F6207',
  slate:'#5B7C8D', plum:'#7D5A76', sage:'#6E8F6B', clay:'#B5714E',
  alert:'#C0432F'
};

/* Categorical series colours, in assignment order. */
var CAT = [PAL.teal, PAL.gold, PAL.tealD, PAL.slate, PAL.tealL,
           PAL.goldL, PAL.plum, PAL.sage, PAL.clay, PAL.tealDD];

/* Sequential ramp for heatmaps: light neutral -> deep brand teal. */
var SEQ = [[0,'#F7FBFB'],[0.25,'#D8ECEB'],[0.5,'#93CBCA'],[0.75,'#3D9291'],[1,'#0F5B5A']];

var plotCfg = { displayModeBar:false, responsive:true };

var plotBase = {
  paper_bgcolor:'rgba(0,0,0,0)',
  plot_bgcolor:'rgba(0,0,0,0)',
  font:{ family:"'Outfit',sans-serif", color:PAL.mid, size:11 },
  margin:{ l:8, r:8, t:10, b:8 },
  hoverlabel:{ bgcolor:'#0F2E2E', bordercolor:'#0F2E2E', align:'left',
               font:{ family:"'Outfit',sans-serif", size:11.5, color:'#FFFFFF' } },
  hovermode:'closest',
  showlegend:false
};

/* Axis presets — used everywhere so gridlines/ticks never drift chart to chart. */
function axV(extra){   /* value axis (numbers) */
  return Object.assign({ showgrid:true, gridcolor:PAL.grid, zeroline:false,
    tickfont:{size:10, color:PAL.soft}, fixedrange:true }, extra||{});
}
function axC(extra){   /* category axis (labels) */
  return Object.assign({ showgrid:false, automargin:true,
    tickfont:{size:11, color:'#2A3535'}, fixedrange:true }, extra||{});
}

/* ---- labels --------------------------------------------------------------
   Wrap on spaces so a long occupation name stays fully readable across two or
   three lines instead of being cut with "…". The untouched original string is
   what goes into the tooltip.                                                 */
function wrapLabel(text, width){
  width = width || 26;
  var words = String(text == null ? '' : text).split(/\s+/);
  var lines = [], cur = '';
  words.forEach(function(w){
    if (!cur) { cur = w; return; }
    if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  return lines.join('<br>');
}
/* Code + wrapped name — only show the name, not the code. */
function codeLabel(code, name, width){
  return wrapLabel(name, width);
}

/* ============================================================================
   drawChart — the only way charts get rendered in this dashboard.
   meta = { title, cols:[...], rows:[[...], ...] }  ->  powers the CSV export.
   ============================================================================ */
function drawChart(id, traces, layout, meta){
  var el = document.getElementById(id);
  if (!el) return;
  Plotly.react(el, traces, Object.assign({}, plotBase, layout || {}), plotCfg);
  el._chartMeta = meta || deriveMeta(id, traces);
  mountChartTools(el, id);
}

/* Fallback CSV data if a caller didn't supply meta: read it off the traces. */
function deriveMeta(id, traces){
  var t = traces && traces[0];
  if (!t) return { title:id, cols:['label'], rows:[] };
  if (t.type === 'heatmap'){
    var cols = ['row'].concat((t.x || []).map(stripTags));
    var rows = (t.y || []).map(function(yv, i){
      return [stripTags(yv)].concat((t.z && t.z[i]) || []);
    });
    return { title:id, cols:cols, rows:rows };
  }
  var horiz = t.orientation === 'h';
  var labels = (horiz ? t.y : t.x) || [];
  var values = (horiz ? t.x : t.y) || [];
  return { title:id, cols:['label','value'],
           rows: labels.map(function(l, i){ return [stripTags(l), values[i]]; }) };
}
function stripTags(s){ return String(s == null ? '' : s).replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').trim(); }

/* ---- export control ------------------------------------------------------ */
function mountChartTools(el, id){
  var host = el.parentNode;
  if (!host) return;
  if (!host.classList.contains('chart-host')){
    var w = document.createElement('div');
    w.className = 'chart-host';
    host.insertBefore(w, el);
    w.appendChild(el);
    host = w;
  }
  if (host.querySelector('.chart-tools')) return;   /* already mounted */

  var tools = document.createElement('div');
  tools.className = 'chart-tools';
  tools.innerHTML =
    '<button type="button" class="chart-btn" aria-haspopup="true" aria-expanded="false" ' +
      'title="Download this chart as an image, or export the numbers behind it">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6v8.2M4.6 6.6L8 10l3.4-3.4M2.4 12.3v1.2a.9.9 0 0 0 .9.9h9.4a.9.9 0 0 0 .9-.9v-1.2"/></svg>' +
      '<span>Export</span>' +
    '</button>' +
    '<div class="chart-menu" role="menu" hidden>' +
      '<button type="button" role="menuitem" data-fmt="png">Download as a PNG image</button>' +
      '<button type="button" role="menuitem" data-fmt="svg">Download as an SVG vector</button>' +
      '<button type="button" role="menuitem" data-fmt="csv">Export the numbers as CSV</button>' +
    '</div>';
  host.appendChild(tools);

  var btn = tools.querySelector('.chart-btn');
  var menu = tools.querySelector('.chart-menu');
  btn.addEventListener('click', function(ev){
    ev.stopPropagation();
    var open = !menu.hidden;
    closeAllChartMenus();
    menu.hidden = open;
    btn.setAttribute('aria-expanded', String(!open));
  });
  menu.querySelectorAll('button').forEach(function(b){
    b.addEventListener('click', function(ev){
      ev.stopPropagation();
      closeAllChartMenus();
      exportChart(id, b.dataset.fmt);
    });
  });
}
function closeAllChartMenus(){
  document.querySelectorAll('.chart-menu').forEach(function(m){ m.hidden = true; });
  document.querySelectorAll('.chart-btn').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
}
document.addEventListener('click', closeAllChartMenus);
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeAllChartMenus(); });

/* ---- the exports themselves ---------------------------------------------- */
function exportChart(id, fmt){
  var el = document.getElementById(id);
  if (!el) return;
  var meta = el._chartMeta || { title:id, cols:[], rows:[] };
  var name = safeName([
    (typeof APP !== 'undefined' && APP.sector ? APP.sector.label : 'GATI'),
    meta.title || id,
    new Date().toISOString().slice(0,10)
  ].join(' - '));

  if (fmt === 'csv'){
    var lines = [meta.cols.map(csvCell).join(',')]
      .concat(meta.rows.map(function(r){ return r.map(csvCell).join(','); }));
    downloadBlob(lines.join('\r\n'), name + '.csv', 'text/csv;charset=utf-8;');
    return;
  }
  var rect = el.getBoundingClientRect();
  Plotly.downloadImage(el, {
    format: fmt,                       /* 'png' | 'svg' */
    filename: name,
    width: Math.max(Math.round(rect.width), 640),
    height: Math.max(Math.round(rect.height), 360),
    scale: fmt === 'png' ? 2 : 1       /* 2x so PNGs are slide-ready */
  });
}
function csvCell(v){
  var s = stripTags(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function safeName(s){ return String(s).replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function downloadBlob(text, filename, mime){
  var blob = new Blob(['\uFEFF' + text], { type: mime });   /* BOM: Excel-friendly */
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 0);
}
