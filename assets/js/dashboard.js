/* ============================================================================
   GATI SECTOR DASHBOARD  —  render engine.
   ----------------------------------------------------------------------------
   A faithful port of the original single-file healthcare dashboard's full
   analysis (all six tabs), driven by the CSV-built DATA model from
   data-loader.js and GENERALISED so any sector renders identically:
     • role groups come from DATA.roleGroups (top ISCO-3), not hardcoded codes
     • cross-tab, trend and role deep-dives build from those groups
     • employer-sector colours fall back to a palette for non-health sectors
     • the About/Methods and Qualifications tabs load per-sector HTML from
       /content (see sector.staticTabs); absent → tab simply doesn't appear
   Tabs 1-4 (Overview, Roles, Regional, Explorer) are 100% data-driven.
   ============================================================================ */

/* ======= APP STATE ======================================================== */
var APP = { filterState:'ALL', filterIsic:'ALL', filterGenuine:true,
            activeTab:'overview', activeRole:null,
            leafletMap:null, mapInit:false,
            sector:null, region:null };
var DATA = null;

/* ======= PALETTE / PLOTLY BASE ==========================================
   The palette, the Plotly base layout and the export control now live in
   chart-kit.js so that every chart is styled and exportable the same way.
   C is kept as a thin alias onto that palette so existing call sites read
   naturally.                                                                */
var C = { teal:PAL.teal, tealD:PAL.tealD, tealL:'#E9F4F4', gold:PAL.gold,
          textD:PAL.ink, textM:PAL.mid, textL:PAL.soft, border:PAL.line,
          coral:PAL.alert, teal2:PAL.tealL,
          emp:[PAL.teal, PAL.tealL, PAL.tealLL, PAL.gold, PAL.goldL, PAL.tealD] };
var ISIC_PALETTE = CAT;
var _isicColMap = {};
function isicColor(name){
  if (typeof ISIC_COLORS !== 'undefined' && ISIC_COLORS[name]) return ISIC_COLORS[name];
  if (!(name in _isicColMap)){
    var used = Object.keys(_isicColMap).length;
    _isicColMap[name] = ISIC_PALETTE[used % ISIC_PALETTE.length];
  }
  return _isicColMap[name];
}

/* ISCO-2 major-group names for the weekly-trend legend (fallback: "ISCO NN"). */
var ISCO2_NAMES = {
  14:'Hospitality & Retail Managers', 21:'Science & Engineering', 22:'Health Professionals',
  23:'Teaching Professionals', 24:'Business & Admin Professionals', 25:'ICT Professionals',
  26:'Legal, Social & Cultural', 31:'Science & Engineering Technicians',
  32:'Health Associate Professionals', 33:'Business & Admin Associates',
  34:'Legal, Social & Cultural Associates', 35:'ICT Technicians',
  41:'General & Keyboard Clerks', 42:'Customer-Service Clerks',
  43:'Numerical & Material-Recording Clerks', 44:'Other Clerical Support',
  51:'Personal Service Workers', 52:'Sales Workers', 53:'Personal Care Workers',
  54:'Protective Services', 71:'Building & Related Trades', 72:'Metal & Machinery Trades',
  73:'Handicraft & Printing', 74:'Electrical & Electronic Trades',
  75:'Food-Processing & Craft', 81:'Stationary Plant & Machine Operators',
  82:'Assemblers', 83:'Drivers & Mobile-Plant Operators',
  91:'Cleaners & Helpers', 92:'Agricultural Labourers',
  93:'Labourers (Mining, Construction, Transport)', 94:'Food-Preparation Assistants',
  95:'Street & Related Sales', 96:'Refuse & Other Elementary Workers' };
var TREND_COLS = [PAL.teal, PAL.gold, PAL.tealD, PAL.slate, PAL.tealL];

/* pc / base are aliases onto chart-kit's shared config (see chart-kit.js). */
var pc   = plotCfg;
var base = plotBase;
var fmt = function(n){ return Number(n).toLocaleString('en-US'); };
var pct = function(n,d){ return d>0 ? (n/d*100).toFixed(1) : '0.0'; };
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* part-time-ish indices, derived once from the sector's employment lookup. */
var PT_IDX = {};
function computePartTime(){
  PT_IDX = {};
  (DATA.lookup.empTypes||[]).forEach(function(l,i){
    if (l==='Part-time' || l==='Full-time or Part-time') PT_IDX[i]=true;
  });
}

/* ======= BOOT ============================================================= */
function qs(k){ return new URLSearchParams(location.search).get(k); }

window.addEventListener('load', function(){
  var id = qs('sector') || (typeof SECTORS!=='undefined' && SECTORS[0] && SECTORS[0].id) || 'healthcare';
  var sector = (typeof getSector==='function' && getSector(id)) || null;
  if (!sector){ showError({kind:'network', message:'No sector "'+id+'" is configured in sectors.js.'}, ''); return; }
  APP.sector = sector;
  APP.region = (typeof regionFor==='function') ? regionFor(sector) : null;

  /* header + switcher + footer chrome */
  document.getElementById('hdr-t1').textContent = sector.label + ' Demand Intelligence';
  document.getElementById('hdr-t2').textContent =
    (APP.region ? APP.region.label : 'Germany') + ' · ' + (sector.source || 'StepStone Germany');
  document.getElementById('map-head').textContent = sector.label + ' Vacancies Across ' + (APP.region? APP.region.label : 'Germany');
  document.getElementById('foot-sector').textContent = sector.label;
  document.title = 'GATI · ' + sector.label + ' Demand Intelligence';
  buildSwitcher(sector.id);

  loadSectorData(sector.id)
    .then(function(built){ DATA = built; initDashboard(); })
    .catch(function(err){ showError(err, csvUrlFor(sector)); });
});

function buildSwitcher(activeId){
  var sel = document.getElementById('hdr-switch');
  if (!sel || typeof SECTORS==='undefined') return;
  sel.innerHTML = SECTORS.map(function(s){
    return '<option value="'+s.id+'"'+(s.id===activeId?' selected':'')+'>'+esc(s.label)+'</option>';
  }).join('');
}
function switchSector(id){ location.href = 'dashboard.html?sector=' + encodeURIComponent(id); }

function showError(err, url){
  var kind = (err && err.kind) || 'network';
  var d = (err && err.diag) || {};
  url = url || d.url || '(unknown)';
  var title, body;

  if (kind === 'http'){
    title = 'CSV not found at that path (HTTP ' + (d.status || '404') + ')';
    body =
      '<p>The dashboard fetched <code>'+esc(url)+'</code> and the server returned '+
      '<b>HTTP '+esc(String(d.status||404))+'</b> — so the file isn\'t at that exact path in your published site. '+
      'The data loading code is fine; the file just isn\'t reachable there. Most common causes, in order:</p>'+
      '<ol style="text-align:left;font-size:12px;color:#3D6060;line-height:1.9;margin:10px 0 0;padding-left:20px">'+
      '<li><b>The CSV is git-ignored.</b> Many repos have <code>*.csv</code> in <code>.gitignore</code>, so it exists locally but was never pushed. Run <code>git check-ignore '+esc(url)+'</code> — if it prints the path, that\'s it. Force-add with <code>git add -f '+esc(url)+'</code>.</li>'+
      '<li><b>Filename / case mismatch.</b> GitHub Pages is case-sensitive. It must be exactly <code>'+esc(url)+'</code> (lowercase, matching the sector <code>id</code>) — not <code>Hospitality.csv</code> or <code>hospitality_final.csv</code>.</li>'+
      '<li><b>Wrong folder.</b> It must sit in <code>/data</code> at the repo root, next to <code>dashboard.html</code>.</li>'+
      '<li><b>Not committed / not deployed yet.</b> Confirm it\'s in the latest commit and the Pages build finished.</li>'+
      '</ol>';
  } else if (kind === 'empty' && d.missing && d.missing.length){
    title = 'CSV loaded, but required columns are missing';
    body =
      '<p>The file at <code>'+esc(url)+'</code> parsed ('+esc(String(d.parsedRows||0))+' rows, delimiter '+
      '<code>'+esc(d.delimiter||',')+'</code>), but these expected columns were not found:</p>'+
      '<p style="margin:8px 0"><b style="color:#D94F3D">'+d.missing.map(esc).join(', ')+'</b></p>'+
      '<p style="font-size:12px;color:#3D6060">Columns detected in your file: <span style="color:#7A9C9C">'+
      (d.headers||[]).slice(0,24).map(esc).join(', ')+(d.headers&&d.headers.length>24?' …':'')+'</span></p>'+
      '<p style="font-size:12px;color:#3D6060;margin-top:8px">Column names are matched case-insensitively and ignore spaces/underscores, so the issue is a genuinely different (or absent) column — re-export from the classifier so it includes '+
      '<code>ISCO_3</code>, <code>ISCO_4</code>, <code>ISCO_4_name</code>, <code>State</code>, and <code>Employer_Category</code>.</p>';
  } else if (kind === 'empty'){
    title = 'CSV loaded, but no rows survived classification';
    body =
      '<p>The file at <code>'+esc(url)+'</code> parsed ('+esc(String(d.parsedRows||0))+' rows, delimiter '+
      '<code>'+esc(d.delimiter||',')+'</code>), but every row was dropped as <i>Out of Scope</i> / <i>CLASSIFICATION_FAILED</i> or had an empty <code>ISCO_4</code>. '+
      'Check that the file is the classifier\'s <b>final</b> output, not the raw scrape.</p>';
  } else {
    title = 'Could not load sector data';
    body =
      '<p>Fetching <code>'+esc(url)+'</code> failed at the network level. '+
      'If you are opening the file directly from disk (<code>file://</code>), the browser blocks it — publish to GitHub Pages or serve over http. '+
      'Otherwise it may be a transient network error.</p>'+
      '<p style="font-size:12px;color:#7A9C9C;margin-top:8px">'+esc(String(err&&err.message||err))+'</p>';
  }

  var s = document.getElementById('db-status');
  s.innerHTML =
    '<div class="status-card" style="max-width:640px;text-align:left">'+
      '<h2 style="color:#D94F3D">'+esc(title)+'</h2>'+ body +
      '<p style="margin-top:14px"><a href="index.html" style="color:#1A7B7A;font-weight:600;text-decoration:none">&larr; Back to all dashboards</a></p>'+
    '</div>';
  s.hidden = false;
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.hidden = true; p.classList.remove('active'); });
}

/* ======= INIT ============================================================= */
function initDashboard(){
  computePartTime();
  populateFilters();
  buildRoleTab();
  buildStaticTabs();
  document.getElementById('db-status').hidden = true;
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.hidden = false; });
  fillDataBanner();
  renderAll();
  renderExplorer();
}

function populateFilters(){
  var st = document.getElementById('flt-state');
  st.innerHTML = '<option value="ALL">All States</option>' +
    DATA.lookup.states.map(function(s){ return '<option value="'+esc(s)+'">'+esc(s)+'</option>'; }).join('');
  var ic = document.getElementById('flt-isic');
  ic.innerHTML = '<option value="ALL">All Employer Types</option>' +
    DATA.lookup.isic.map(function(s){ return '<option value="'+esc(s)+'">'+esc(s)+'</option>'; }).join('');
  document.getElementById('flt-genuine').checked = APP.filterGenuine;
}

function fillDataBanner(){
  var m = DATA.meta, s = APP.sector;
  var items = [
    ['Source', s.source || 'StepStone Germany'],
    ['Period', m.dateRange || '—'],
    ['Postings Loaded', fmt(m.scraped)],
    ['In-scope '+s.label+' Postings', fmt(m.total)]
  ];
  document.getElementById('data-banner').innerHTML = items.map(function(it,i){
    return (i? '<span class="db-sep">|</span>' : '') +
      '<div class="db-item"><span class="db-label">'+esc(it[0])+'</span><span class="db-val">'+esc(it[1])+'</span></div>';
  }).join('');
}

/* ======= DATA HELPERS ===================================================== */
function getRows(){
  var si = APP.filterState!=='ALL' ? DATA.lookup.states.indexOf(APP.filterState) : -999;
  var ii = APP.filterIsic!=='ALL'  ? DATA.lookup.isic.indexOf(APP.filterIsic)   : -999;
  return DATA.rows.filter(function(r){
    if (si!==-999 && r[0]!==si) return false;
    if (ii!==-999 && r[1]!==ii) return false;
    if (APP.filterGenuine && r[6]===1) return false;
    return true;
  });
}
function applyFilters(){
  APP.filterState   = document.getElementById('flt-state').value;
  APP.filterIsic    = document.getElementById('flt-isic').value;
  APP.filterGenuine = document.getElementById('flt-genuine').checked;
  EXP_PAGE = 0;
  renderAll();
}

/* ======= TAB SWITCHING ==================================================== */
function showTab(id, btn){
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  var panel = document.getElementById('tab-'+id);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
  APP.activeTab = id;
  var rows = getRows();
  if (id==='roles')      renderRoleTab(rows, APP.activeRole);
  if (id==='regional'){  renderStateBar(rows); renderStateTable(rows); initMap(); }
  if (id==='explorer')   renderExplorer();
  if (id==='classify')   renderClassifications(rows);
  if (id==='tiers')      renderTiers();
}

/* ======= RENDER ALL ======================================================= */
function renderAll(){
  var rows = getRows();
  document.getElementById('filter-count').textContent = fmt(rows.length) + ' postings';
  updateKPIs(rows); renderAlert(rows);
  renderTop10(rows); renderCrossTab(rows);
  renderTrend(rows); renderIsicBar(rows);
  if (APP.activeTab==='roles')      renderRoleTab(rows, APP.activeRole);
  if (APP.activeTab==='regional'){  renderStateBar(rows); renderStateTable(rows); }
  if (APP.activeTab==='explorer')   renderExplorer();
  if (APP.activeTab==='classify')   renderClassifications(rows);
  if (APP.activeTab==='tiers')      renderTiers();
}

/* ======= KPIs ============================================================= */
function kpi(id,val,lbl,sub){
  var el=document.getElementById(id);
  if(el) el.innerHTML='<span class="kpi-val">'+val+'</span><span class="kpi-lbl">'+lbl+'</span><span class="kpi-sub">'+sub+'</span>';
}
function updateKPIs(rows){
  var total = rows.length;
  var lead  = DATA.roleGroups[0];
  var leadN = lead ? rows.filter(function(r){ return r[3]===lead.code; }).length : 0;
  var pt    = rows.filter(function(r){ return PT_IDX[r[5]]; }).length;
  var stc={}; rows.forEach(function(r){ if(r[0]>=0){ var s=DATA.lookup.states[r[0]]; stc[s]=(stc[s]||0)+1; } });
  var top3 = Object.keys(stc).map(function(k){return [k,stc[k]];}).sort(function(a,b){return b[1]-a[1];}).slice(0,3);
  var top3n = top3.reduce(function(s,e){return s+e[1];},0);
  var top3p = total>0 ? Math.round(top3n/total*100) : 0;
  var topSt = top3[0] ? top3[0][0] : 'N/A';
  var wk = DATA.meta.weeks || 1;
  kpi('kpi-total', fmt(total), 'In-scope '+APP.sector.label+' Vacancies', 'Approx. '+fmt(Math.round(total/Math.max(wk,1)))+' new postings per week');
  kpi('kpi-lead', pct(leadN,total)+'%', (lead? lead.name : 'Lead')+' Roles', fmt(leadN)+' postings — largest role group');
  kpi('kpi-parttime', pct(pt,total)+'%', 'Open to Part-time', 'Accept flexible or part-time arrangements');
  kpi('kpi-geo', top3p+'%', 'Demand in Top 3 States', 'Led by '+topSt+': geographic concentration of demand');
}

/* ============================================================================
   hBar — the shared horizontal bar chart.
   Every bar chart in the dashboard is drawn through this so that labelling,
   colour, hover and export behave identically everywhere. Labels wrap across
   lines instead of being cut off; the untouched full name, the count and the
   share all appear in the tooltip.
     items: [{ label, code?, count, color? }]
   ============================================================================ */
function hBar(id, items, opts){
  opts = opts || {};
  var el = document.getElementById(id);
  if (!el) return;
  if (!items.length){
    el.innerHTML = '<p class="chart-empty">There is no data for this selection.</p>';
    return;
  }
  var total = (opts.total != null) ? opts.total
            : items.reduce(function(s,d){ return s + d.count; }, 0);
  var asPct = opts.pct !== false;
  var s = items.slice().sort(function(a,b){ return a.count - b.count; });   /* ascending: biggest ends on top */
  var vals = s.map(function(d){ return asPct ? +(d.count/Math.max(total,1)*100).toFixed(1) : d.count; });
  var maxV = Math.max.apply(null, vals) || 1;

  drawChart(id, [{
    type:'bar', orientation:'h',
    y: s.map(function(d){ return codeLabel(d.code, d.label, opts.wrap || 26); }),
    x: vals,
    customdata: s.map(function(d){
      return [ (d.code ? d.code + ' · ' : '') + d.label, d.count,
               total ? +(d.count/total*100).toFixed(1) : 0 ];
    }),
    marker:{ color: opts.color || s.map(function(d){ return d.color || PAL.teal; }),
             line:{ width:0 } },
    text: s.map(function(d,i){ return asPct ? vals[i] + '%' : fmt(d.count); }),
    textposition:'outside', textfont:{ size:10, color:PAL.mid }, cliponaxis:false,
    hovertemplate:'<b>%{customdata[0]}</b><br>' +
                  '%{customdata[1]:,} postings<br>' +
                  '%{customdata[2]:.1f}% of ' + (opts.ofWhat || 'postings') +
                  '<extra></extra>'
  }], {
    xaxis: axV({ showticklabels:false, range:[0, maxV * 1.18] }),
    yaxis: axC({ tickfont:{ size: opts.tick || 10, color:PAL.mid } }),
    bargap:0.28,
    margin:{ l:8, r: opts.rightPad || 56, t:10, b:8 }
  }, {
    title: opts.title || id,
    cols: ['Code','Name','Postings','Share of ' + (opts.ofWhat || 'postings') + ' (%)'],
    rows: s.slice().reverse().map(function(d){
      return [ d.code || '', d.label, d.count, total ? +(d.count/total*100).toFixed(1) : 0 ];
    })
  });
}

function renderAlert(rows){
  var total=rows.length, ic={}, isicc={};
  rows.forEach(function(r){ var l=DATA.lookup.isco4[r[4]]; if(l&&l!=='Other') ic[l]=(ic[l]||0)+1; });
  rows.forEach(function(r){ if(r[1]>=0){ var c=DATA.lookup.isic[r[1]]; isicc[c]=(isicc[c]||0)+1; } });
  var tr = topKeyOf(ic)||'N/A', te = topKeyOf(isicc)||'N/A';
  var el=document.getElementById('ov-alert');
  if(el) el.innerHTML='<b>Key finding:</b> Germany\'s '+esc(APP.sector.label.toLowerCase())+
    ' sector posted <b>'+fmt(total)+' in-scope vacancies</b> over the '+esc(DATA.meta.dateRange||'collection')+' window. '+
    'Most-advertised occupation: <b>'+esc(tr)+'</b>. Largest hiring sector: <b>'+esc(te)+'</b>. '+
    'All figures reflect the current header filters (state, employer type, genuine employers).';
}
function topKeyOf(o){ var b=null,n=-1; for(var k in o) if(o[k]>n){n=o[k];b=k;} return b; }

/* ======= TOP 10 =========================================================== */
function renderTop10(rows){
  var total=rows.length, c={};
  rows.forEach(function(r){ var l=DATA.lookup.isco4[r[4]]; if(l&&l!=='Other') c[l]=(c[l]||0)+1; });
  var items=Object.keys(c).map(function(k){
    return { label:k, code:(DATA.isco4CodeByName&&DATA.isco4CodeByName[k])||'', count:c[k] };
  }).sort(function(a,b){return b.count-a.count;}).slice(0,10);
  hBar('chart-top10', items, { total:total, color:PAL.teal, wrap:28,
       ofWhat:'in-scope postings', title:'Top 10 occupations by demand share' });
}

/* ======= EMPLOYER BAR ===================================================== */
function renderIsicBar(rows){
  var total=rows.length, c={};
  rows.forEach(function(r){ if(r[1]>=0){ var cat=DATA.lookup.isic[r[1]]; c[cat]=(c[cat]||0)+1; } });
  var items=Object.keys(c).map(function(k){ return { label:k, count:c[k], color:isicColor(k) }; });
  hBar('chart-isic', items, { total:total, wrap:24,
       ofWhat:'in-scope postings', title:'Postings by employer sector' });
}

/* ======= CROSS-TAB ======================================================== */
function renderCrossTab(rows){
  var grps = DATA.roleGroups.map(function(g){ return { code:g.code, name:wrapName(g.name) }; });
  var isicList = DATA.lookup.isic.slice(0,8);
  var matrix={}, totals={};
  grps.forEach(function(g){ totals[g.code]=0; });
  rows.forEach(function(r){
    if(r[1]<0) return;
    var g=grps.find(function(x){return x.code===r[3];}); if(!g) return;
    var isic=DATA.lookup.isic[r[1]];
    if(!matrix[isic]) matrix[isic]={};
    matrix[isic][g.code]=(matrix[isic][g.code]||0)+1;
    totals[g.code]=(totals[g.code]||0)+1;
  });
  var zData=isicList.map(function(isic){ return grps.map(function(g){
    return +(((matrix[isic]?matrix[isic][g.code]||0:0)/Math.max(totals[g.code],1))*100).toFixed(1); }); });
  var textData=isicList.map(function(isic){ return grps.map(function(g){
    return (((matrix[isic]?matrix[isic][g.code]||0:0)/Math.max(totals[g.code],1))*100).toFixed(0)+'%'; }); });
  var zMax=Math.max.apply(null, zData.reduce(function(a,b){return a.concat(b);},[]).concat([1]));
  var annotations=[];
  isicList.forEach(function(isic,yi){ grps.forEach(function(g,xi){
    var v=zData[yi][xi]; var txtCol = v/zMax>0.45 ? '#fff' : '#0F2E2E';
    annotations.push({x:g.name,y:isic,text:textData[yi][xi],xref:'x',yref:'y',showarrow:false,
      font:{size:10,color:txtCol,family:'Outfit'}});
  }); });
  drawChart('chart-cross',[{type:'heatmap',
    x:grps.map(function(g){return g.name;}), y:isicList, z:zData,
    colorscale:SEQ,
    showscale:true,
    colorbar:{thickness:10,len:0.85,tickfont:{size:9,family:'Outfit'},ticksuffix:'%',outlinewidth:0,
              title:{text:'Share',font:{size:9}}},
    hovertemplate:'<b>%{y}</b><br>%{x}<br>%{z:.1f}% of this group\'s postings<extra></extra>', xgap:4, ygap:4}],
    {xaxis:{showgrid:false,tickfont:{size:9.5,color:PAL.mid},fixedrange:true,tickangle:0,automargin:true},
     yaxis:{showgrid:false,automargin:true,tickfont:{size:10,color:PAL.mid},fixedrange:true},
     annotations:annotations, margin:{l:8,r:60,t:16,b:36}},
    {title:'Employer sector by workforce group',
     cols:['Employer sector'].concat(grps.map(function(g){return stripTags(g.name);})),
     rows:isicList.map(function(isic,yi){ return [isic].concat(zData[yi]); })});
}
function wrapName(n){
  var w=n.split(' '); if(w.length<2) return n;
  var mid=Math.ceil(w.length/2);
  return w.slice(0,mid).join(' ')+'<br>'+w.slice(mid).join(' ');
}

/* ======= TREND CHART ====================================================== */
function renderTrend(rows){
  var wl=DATA.lookup.weekLabels;
  var el=document.getElementById('chart-trend');
  if(!wl.length){ if(el) el.innerHTML='<p class="chart-empty">No dated postings are available, so a weekly trend cannot be drawn.</p>'; return; }
  /* top ISCO-2 groups present (up to 5) */
  var c2={}; rows.forEach(function(r){ if(r[2]>0) c2[r[2]]=(c2[r[2]]||0)+1; });
  var groups=Object.keys(c2).map(function(k){return parseInt(k,10);})
    .sort(function(a,b){return c2[b]-c2[a];}).slice(0,5);
  var series={};
  var traces=groups.map(function(i2,gi){
    var y=Array(wl.length).fill(0);
    rows.forEach(function(r){ if(r[2]===i2 && r[7]>=0) y[r[7]]++; });
    var nm=(ISCO2_NAMES[i2]||('ISCO '+i2))+' ('+i2+')';
    series[nm]=y;
    var col=TREND_COLS[gi%TREND_COLS.length];
    return {x:wl,y:y,type:'scatter',mode:'lines+markers',name:nm,
      line:{color:col,width:2.5,shape:'spline'},marker:{color:col,size:5},
      fill:'tozeroy',fillcolor:col+'14',
      hovertemplate:'%{y:,d} postings<extra><b>'+nm+'</b></extra>'};
  });
  drawChart('chart-trend',traces,{
    hovermode:'x unified',
    showlegend:true,
    xaxis:{showgrid:false,tickfont:{size:10,color:PAL.mid},fixedrange:true,showspikes:true,
           spikethickness:1,spikedash:'dot',spikecolor:PAL.soft,spikemode:'across'},
    yaxis:axV({title:{text:'Postings per week',font:{size:10,color:PAL.soft}},zeroline:true,zerolinecolor:PAL.line}),
    legend:{orientation:'h',y:-0.34,font:{size:9.5,color:PAL.mid},bgcolor:'rgba(0,0,0,0)'},
    margin:{l:48,r:8,t:12,b:84}},
    {title:'Weekly posting volume by workforce group',
     cols:['Week starting'].concat(Object.keys(series)),
     rows:wl.map(function(w,i){ return [w].concat(Object.keys(series).map(function(k){return series[k][i];})); })});
}

/* ======= ROLE TAB (dynamic) =============================================== */
function buildRoleTab(){
  var nav=document.getElementById('role-sub-nav');
  var wrap=document.getElementById('role-panels');
  nav.innerHTML=''; wrap.innerHTML='';
  DATA.roleGroups.forEach(function(g,i){
    var b=document.createElement('button');
    b.className='sub-btn'+(i===0?' active':'');
    b.textContent=g.name+' ('+g.code+')';
    b.onclick=function(){ showRole(g.code,b); };
    nav.appendChild(b);

    var p=document.createElement('div');
    p.className='sub-panel'+(i===0?' active':'');
    p.id='role-panel-'+g.code;
    p.innerHTML=
      '<div class="insight-box" id="role-insight-'+g.code+'"></div>'+
      '<div class="kpi-row">'+
        '<div class="kpi-card"><div class="kpi-accent" style="background:#1A7B7A"></div><div class="kpi-body" id="rk1-'+g.code+'"></div></div>'+
        '<div class="kpi-card"><div class="kpi-accent" style="background:#2D9B9A"></div><div class="kpi-body" id="rk2-'+g.code+'"></div></div>'+
        '<div class="kpi-card"><div class="kpi-accent" style="background:#D4940A"></div><div class="kpi-body" id="rk3-'+g.code+'"></div></div>'+
        '<div class="kpi-card"><div class="kpi-accent" style="background:#0F5B5A"></div><div class="kpi-body" id="rk4-'+g.code+'"></div></div>'+
      '</div>'+
      '<div class="grid-2" style="grid-template-columns:3fr 2fr">'+
        '<div class="card card-t"><div class="card-head">Top Occupation Types (ISCO-4)</div>'+
          '<div class="card-sub">Standardised ISCO-4 categories most in demand, as a % of postings in this group</div>'+
          '<div class="card-body"><div id="rc-top-'+g.code+'" style="height:300px"></div></div></div>'+
        '<div class="card card-g"><div class="card-head">Contract Type</div>'+
          '<div class="card-sub">Distribution of employment arrangements</div>'+
          '<div class="card-body"><div id="rc-emp-'+g.code+'" style="height:140px"></div></div>'+
          '<div class="card-head" style="margin-top:4px">Hiring Employer Sectors</div>'+
          '<div class="card-sub">Which sectors advertise for this group</div>'+
          '<div class="card-body"><div id="rc-isic-'+g.code+'" style="height:140px"></div></div></div>'+
      '</div>'+
      '<div class="card card-b"><div class="card-head">Top Hiring Companies</div>'+
        '<div class="card-sub">Employers with the most openings (all states). Colour indicates employer sector.</div>'+
        '<div class="card-body"><div id="rc-cos-'+g.code+'" style="height:330px"></div></div></div>'+
      '<div class="card card-g" style="margin-top:14px"><div class="card-head">Top 3 Employers by Sector</div>'+
        '<div class="card-sub">Leading hiring organisations within each employer sector for this role group</div>'+
        '<div class="tbl-wrap" id="rc-empbysec-'+g.code+'"></div></div>';
    wrap.appendChild(p);
  });
  APP.activeRole = DATA.roleGroups.length ? DATA.roleGroups[0].code : null;
}

function showRole(code, btn){
  document.querySelectorAll('#tab-roles .sub-btn').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('#tab-roles .sub-panel').forEach(function(p){ p.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  var p=document.getElementById('role-panel-'+code); if(p) p.classList.add('active');
  APP.activeRole=code;
  renderRoleTab(getRows(), code);
}

function renderRoleTab(rows, code){
  if(code==null) return;
  var g = DATA.roleGroups.find(function(x){return x.code===code;}); if(!g) return;
  var sub=rows.filter(function(r){return r[3]===code;}), tot=sub.length, allTot=rows.length;
  var meta=(typeof ROLE_META!=='undefined' && ROLE_META[code]) ? ROLE_META[code] : null;

  var el=document.getElementById('role-insight-'+code);
  if(el) el.innerHTML='<b>'+esc(g.name)+'</b> — <b>'+fmt(tot)+' postings</b> ('+pct(tot,allTot)+'% of all '+
    esc(APP.sector.label.toLowerCase())+' demand). '+(meta?meta.desc:'');

  var pt=sub.filter(function(r){return PT_IDX[r[5]];}).length;
  var isicc={}; sub.forEach(function(r){ if(r[1]>=0){ var c=DATA.lookup.isic[r[1]]; isicc[c]=(isicc[c]||0)+1; } });
  var topEmp=topKeyOf(isicc)||'N/A';
  var stc={}; sub.forEach(function(r){ if(r[0]>=0){ var s=DATA.lookup.states[r[0]]; stc[s]=(stc[s]||0)+1; } });
  var topSt=topKeyOf(stc)||'N/A';
  kpi('rk1-'+code, pct(tot,allTot)+'%','Share of Sector Demand', fmt(tot)+' of '+fmt(allTot)+' total postings');
  kpi('rk2-'+code, pct(pt,tot)+'%','Open to Part-time','Flexible or part-time arrangements accepted');
  kpi('rk3-'+code, topEmp,'Top Employer Sector','Largest hiring sector for this group');
  kpi('rk4-'+code, topSt,'Top State','Highest posting volume state for this group');

  /* Top ISCO-4 occupations within this role group */
  var ic4={}; sub.forEach(function(r){ var l=DATA.lookup.isco4[r[4]]; if(l&&l!=='Other') ic4[l]=(ic4[l]||0)+1; });
  var items4=Object.keys(ic4).map(function(k){
    return { label:k, code:(DATA.isco4CodeByName&&DATA.isco4CodeByName[k])||'', count:ic4[k] };
  }).sort(function(a,b){return b.count-a.count;}).slice(0,10);
  hBar('rc-top-'+code, items4, { total:tot, color:g.color, wrap:26,
       ofWhat:'postings in this group', title:g.name+' — top occupations' });

  /* Contract type */
  var ec={}; sub.forEach(function(r){ ec[r[5]]=(ec[r[5]]||0)+1; });
  var itemsE=DATA.lookup.empTypes.map(function(l,i){
    return { label:l, count:ec[i]||0, color:C.emp[i%C.emp.length] };
  }).filter(function(d){return d.count>0;});
  hBar('rc-emp-'+code, itemsE, { total:tot, wrap:22,
       ofWhat:'postings in this group', title:g.name+' — contract type' });

  /* Employer sectors */
  var itemsS=Object.keys(isicc).map(function(k){
    return { label:k, count:isicc[k], color:isicColor(k) };
  });
  hBar('rc-isic-'+code, itemsS, { total:tot, wrap:24,
       ofWhat:'postings in this group', title:g.name+' — employer sectors' });

  /* Top companies (pre-computed) */
  var cos=(DATA.companies[String(code)]||[]).slice(0,15).map(function(d){
    return { label:d.name, count:d.count, color:isicColor(d.isic) };
  });
  hBar('rc-cos-'+code, cos, { total:tot, pct:false, wrap:26, tick:9.5,
       ofWhat:'postings in this group', title:g.name+' — top employers' });

  renderEmployersBySector(code);
}

function renderEmployersBySector(code){
  var el=document.getElementById('rc-empbysec-'+code); if(!el) return;
  var bySector=(DATA.sectorEmployers && DATA.sectorEmployers[String(code)]) || {};
  var sectors=Object.keys(bySector).filter(function(s){ return bySector[s]&&bySector[s].length>0; })
    .sort(function(a,b){
      var sa=bySector[a].reduce(function(x,e){return x+e.count;},0);
      var sb=bySector[b].reduce(function(x,e){return x+e.count;},0);
      return sb-sa;
    });
  if(!sectors.length){ el.innerHTML='<p style="padding:12px;color:#7A9C9C;font-size:11px">No employer data available.</p>'; return; }
  var html='<table class="data-tbl"><thead><tr>'+
    '<th style="width:36%">Employer Sector</th><th style="width:28px;text-align:center">#</th>'+
    '<th>Employer</th><th style="text-align:right">Postings</th></tr></thead><tbody>';
  sectors.forEach(function(sector){
    var emps=(bySector[sector]||[]).slice(0,3), col=isicColor(sector);
    emps.forEach(function(e,i){
      html+='<tr>';
      if(i===0) html+='<td rowspan="'+emps.length+'" style="font-weight:600;color:'+col+';vertical-align:middle;border-left:3px solid '+col+'">'+esc(sector)+'</td>';
      html+='<td style="color:#7A9C9C;font-size:10px;text-align:center">'+(i+1)+'</td>'+
        '<td>'+esc(e.name)+'</td><td class="cnt" style="text-align:right">'+fmt(e.count)+'</td></tr>';
    });
  });
  el.innerHTML=html+'</tbody></table>';
}

/* ======= MAP ============================================================== */
var geoJSON=null;
function initMap(){
  if(APP.mapInit) return; APP.mapInit=true;
  if(!APP.region || !APP.region.geojson){ document.getElementById('geo-insight').textContent='No map configured for this region.'; return; }
  fetch(APP.region.geojson).then(function(r){return r.json();})
    .then(function(d){ geoJSON=d; renderMap(); })
    .catch(function(){ document.getElementById('geo-insight').textContent='Map unavailable offline. Use the bar chart and table below.'; });
}
function renderMap(){
  if(!geoJSON) return;
  if(APP.leafletMap){ APP.leafletMap.remove(); APP.leafletMap=null; }
  var reg=APP.region, nameMap=reg.nameMap||{};
  APP.leafletMap=L.map('geo-map',{zoomControl:false}).setView(reg.center||[51.2,10.4], reg.zoom||5);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    {attribution:'&copy; CartoDB',opacity:0.55}).addTo(APP.leafletMap);
  var geo=DATA.stateGeo;
  var maxHC=Math.max.apply(null, Object.keys(geo).map(function(k){return geo[k].hc;}).concat([1]));
  function getCol(hc){ var t=hc/maxHC;
    return 'rgb('+Math.round(229-t*214)+','+Math.round(242-t*151)+','+Math.round(242-t*152)+')'; }
  L.geoJSON(geoJSON,{
    style:function(f){ var en=nameMap[f.properties.name], d=en&&geo[en];
      return {fillColor:d?getCol(d.hc):'#F0F4F4',fillOpacity:0.85,color:'white',weight:1.5}; },
    onEachFeature:function(f,layer){
      var en=nameMap[f.properties.name], d=en&&geo[en];
      if(d){
        var rh=d.topRoles.map(function(r,i){return '<div style="margin-bottom:2px">'+(i+1)+'. '+esc(r)+'</div>';}).join('');
        layer.bindTooltip(
          '<div style="font-family:Outfit,sans-serif;min-width:210px">'+
          '<div style="font-size:14px;font-weight:700;color:#0F5B5A;border-bottom:2px solid #D4940A;padding-bottom:5px;margin-bottom:8px">'+esc(en)+'</div>'+
          '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#3D6060">Vacancies</span><b style="color:#1A7B7A;font-size:15px">'+d.hc.toLocaleString('en-US')+'</b></div>'+
          '<div style="font-size:9px;font-weight:700;color:#7A9C9C;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Top Roles</div>'+rh+
          '<div style="font-size:9px;font-weight:700;color:#7A9C9C;text-transform:uppercase;margin:8px 0 3px">Top Employer Sector</div>'+
          '<div style="color:#D4940A;font-weight:600">'+esc(d.topEmp)+'</div></div>',
          {sticky:false,direction:'auto'});
        layer.on('mouseover',function(){ this.setStyle({weight:3,color:'#D4940A',fillOpacity:0.95}); });
        layer.on('mouseout', function(){ this.setStyle({weight:1.5,color:'white',fillOpacity:0.85}); });
      }
    }
  }).addTo(APP.leafletMap);
  var leg=L.control({position:'bottomright'});
  leg.onAdd=function(){ var d=L.DomUtil.create('div');
    d.style.cssText='background:white;padding:10px 14px;border-radius:8px;font-family:Outfit,sans-serif;font-size:11px;border:1px solid #D4E5E5;box-shadow:0 2px 8px rgba(15,46,46,.1)';
    d.innerHTML='<b style="color:#0F2E2E">Vacancies</b><br><div style="display:flex;align-items:center;gap:6px;margin-top:6px"><div style="width:80px;height:12px;background:linear-gradient(to right,#E5F2F2,#0F5B5A);border-radius:2px"></div></div><div style="display:flex;justify-content:space-between;width:80px;font-size:9px;color:#7A9C9C;margin-top:2px"><span>Low</span><span>High</span></div>';
    return d; };
  leg.addTo(APP.leafletMap);
  var el=document.getElementById('geo-insight');
  var tot=Object.keys(geo).reduce(function(s,k){return s+geo[k].hc;},0);
  var top=Object.keys(geo).map(function(k){return [k,geo[k].hc];}).sort(function(a,b){return b[1]-a[1];})[0];
  if(el&&top) el.innerHTML='<b>Geographic coverage:</b> '+fmt(tot)+' postings have state-level location data across '+
    Object.keys(geo).length+' '+(reg.unit||'regions')+'. <b>Hover each state</b> to view top roles and leading employer sector. Leading state: <b>'+esc(top[0])+'</b> with '+fmt(top[1])+' openings.';
}

/* ======= STATE BAR & TABLE ================================================ */
function renderStateBar(rows){
  var c={}; rows.forEach(function(r){ if(r[0]>=0){ var s=DATA.lookup.states[r[0]]; c[s]=(c[s]||0)+1; } });
  var tot=rows.length;
  var items=Object.keys(c).map(function(k){ return { label:k, count:c[k] }; });
  hBar('chart-states', items, { total:tot, color:PAL.teal, wrap:22,
       ofWhat:'in-scope postings', title:'States ranked by demand' });
}
function renderStateTable(rows){
  var sc={}, si2={};
  rows.forEach(function(r){
    if(r[0]<0) return;
    var s=DATA.lookup.states[r[0]]; sc[s]=(sc[s]||0)+1;
    if(r[1]>=0){ if(!si2[s]) si2[s]={}; var ic=DATA.lookup.isic[r[1]]; si2[s][ic]=(si2[s][ic]||0)+1; }
  });
  var tot=rows.length, sorted=Object.keys(sc).map(function(k){return [k,sc[k]];}).sort(function(a,b){return b[1]-a[1];});
  var html='<table class="data-tbl"><thead><tr><th>State</th><th>Postings</th><th>% of Total</th><th>Top Employer Sector</th></tr></thead><tbody>';
  sorted.forEach(function(pair){
    var s=pair[0], n=pair[1];
    var te=si2[s]?topKeyOf(si2[s]):'N/A';
    html+='<tr><td><b>'+esc(s)+'</b></td><td class="cnt">'+fmt(n)+'</td><td>'+pct(n,tot)+'%</td><td>'+esc(te)+'</td></tr>';
  });
  document.getElementById('state-table').innerHTML=html+'</tbody></table>';
}

/* ======= DATA EXPLORER ==================================================== */
var EXP_PAGE=0, EXP_SEARCH='', EXP_PS=50, _rowToIdx=null;

/* Maps a row array back to its index so the raw text columns can be read. */
function ensureIdx(){
  if(!_rowToIdx){ _rowToIdx=new Map(); DATA.rows.forEach(function(r,i){ _rowToIdx.set(r,i); }); }
}

function renderExplorer(){
  var html='<table class="data-tbl"><thead><tr><th>Role Group (ISCO-3)</th><th>Code</th><th>Total Postings</th><th>% Open to Part-time</th><th>Top Employer Sector</th><th>Top State</th></tr></thead><tbody>';
  DATA.roleTable.forEach(function(r){
    var hi=parseFloat(r.ptPct)>60;
    html+='<tr><td><b>'+esc(r.name)+'</b></td><td><span class="badge">'+r.isco3+'</span></td><td class="cnt">'+fmt(r.count)+'</td><td class="'+(hi?'gld':'')+'">'+r.ptPct+'%</td><td>'+esc(r.topEmp)+'</td><td>'+esc(r.topState)+'</td></tr>';
  });
  document.getElementById('explorer-table').innerHTML=html+'</tbody></table>';
  renderFullTable();
}
function explorerSearch(){ EXP_SEARCH=document.getElementById('exp-search').value.toLowerCase(); EXP_PAGE=0; renderFullTable(); }

function renderFullTable(){
  ensureIdx();
  var rows=getRows();
  var R=DATA.raw;
  var decoded=rows.map(function(r){
    var i=_rowToIdx.get(r);
    return {
      title:R.title[i]||'', date:R.date[i]||'', company:R.company[i]||'',
      empCat:R.empCat[i]||'', salary:R.salary[i]||'', desc:R.desc[i]||'',
      req:R.req[i]||'', benefits:R.benefits[i]||'', workType:R.workType[i]||'', url:R.url[i]||'',
      state:r[0]>=0?DATA.lookup.states[r[0]]:'',
      isic:r[1]>=0?DATA.lookup.isic[r[1]]:'',
      grp:(typeof ISCO3_NAMES!=='undefined'&&ISCO3_NAMES[r[3]])||(r[3]?'ISCO '+r[3]:''),
      occ:(r[4]>=0?DATA.lookup.isco4[r[4]]:null)||'Other',
      empType:DATA.lookup.empTypes[r[5]]||''
    };
  });
  if(EXP_SEARCH){
    var q=EXP_SEARCH;
    decoded=decoded.filter(function(d){
      return d.title.toLowerCase().indexOf(q)>=0 || d.state.toLowerCase().indexOf(q)>=0 ||
        d.grp.toLowerCase().indexOf(q)>=0 || d.occ.toLowerCase().indexOf(q)>=0 ||
        d.company.toLowerCase().indexOf(q)>=0 || d.isic.toLowerCase().indexOf(q)>=0 ||
        d.desc.toLowerCase().indexOf(q)>=0 || d.empCat.toLowerCase().indexOf(q)>=0;
    });
  }
  var total=decoded.length, totalPages=Math.max(1,Math.ceil(total/EXP_PS));
  EXP_PAGE=Math.min(EXP_PAGE,totalPages-1);
  var page=decoded.slice(EXP_PAGE*EXP_PS,(EXP_PAGE+1)*EXP_PS);

  var html='<table class="data-tbl" style="min-width:1800px"><thead><tr>'+
    '<th style="min-width:30px">#</th><th style="min-width:200px">Job Title</th>'+
    '<th style="min-width:90px">Date Posted</th><th style="min-width:140px">Company</th>'+
    '<th style="min-width:130px">State</th><th style="min-width:160px">Occupation (ISCO-4)</th>'+
    '<th style="min-width:170px">Role Group (ISCO-3)</th><th style="min-width:150px">Employer Sector</th>'+
    '<th style="min-width:140px">Employer Category</th><th style="min-width:130px">Contract Type</th>'+
    '<th style="min-width:80px">Salary</th><th style="min-width:80px">Work Type</th>'+
    '<th style="min-width:300px">Description</th><th style="min-width:220px">Requirements</th>'+
    '<th style="min-width:200px">Benefits</th><th style="min-width:60px">URL</th></tr></thead><tbody>';
  page.forEach(function(d,i){
    var rowNum=EXP_PAGE*EXP_PS+i+1;
    html+='<tr>'+
      '<td style="color:#7A9C9C;font-size:10px;white-space:nowrap">'+rowNum+'</td>'+
      '<td><b style="font-size:11px;color:#0F2E2E">'+esc(d.title)+'</b></td>'+
      '<td style="white-space:nowrap;font-size:10px">'+esc(d.date)+'</td>'+
      '<td style="font-size:10px">'+esc(d.company)+'</td>'+
      '<td style="font-size:10px"><b>'+esc(d.state)+'</b></td>'+
      '<td style="color:#1A7B7A;font-size:10px">'+esc(d.occ)+'</td>'+
      '<td style="font-size:10px">'+esc(d.grp)+'</td>'+
      '<td style="font-size:10px">'+esc(d.isic)+'</td>'+
      '<td style="font-size:10px;color:#7A9C9C">'+esc(d.empCat)+'</td>'+
      '<td style="font-size:10px;white-space:nowrap">'+esc(d.empType)+'</td>'+
      '<td style="font-size:10px;color:#D4940A">'+esc(d.salary)+'</td>'+
      '<td style="font-size:10px;white-space:nowrap">'+esc(d.workType)+'</td>'+
      '<td class="desc-cell"><div class="clampy" title="'+esc(d.desc)+'">'+esc(d.desc)+'</div></td>'+
      '<td class="desc-cell"><div class="clampy" title="'+esc(d.req)+'">'+esc(d.req)+'</div></td>'+
      '<td class="desc-cell"><div class="clampy" title="'+esc(d.benefits)+'">'+esc(d.benefits)+'</div></td>'+
      '<td class="link-cell">'+(d.url?'<a href="'+esc(d.url)+'" target="_blank" rel="noopener">View</a>':'')+'</td>'+
      '</tr>';
  });
  document.getElementById('explorer-full').innerHTML=html+'</tbody></table>';

  var navEl=document.getElementById('explorer-nav');
  var btnOn='padding:5px 12px;border:1px solid #D4E5E5;border-radius:6px;background:#fff;font-family:Outfit,sans-serif;font-size:11px;cursor:pointer;color:#1A7B7A;font-weight:600';
  var btnOff='padding:5px 12px;border:1px solid #D4E5E5;border-radius:6px;background:#F2F6F6;font-family:Outfit,sans-serif;font-size:11px;cursor:default;color:#B0C8C8';
  window._expTotalPages=totalPages;
  navEl.innerHTML=
    '<button style="'+(EXP_PAGE===0?btnOff:btnOn)+'" '+(EXP_PAGE===0?'disabled':'')+' onclick="EXP_PAGE=Math.max(0,EXP_PAGE-1);renderFullTable()">Prev</button>'+
    '<span style="color:#3D6060">Page <b>'+(EXP_PAGE+1)+'</b> of <b>'+totalPages+'</b> · <b>'+fmt(total)+'</b> matching postings</span>'+
    '<button style="'+(EXP_PAGE>=totalPages-1?btnOff:btnOn)+'" '+(EXP_PAGE>=totalPages-1?'disabled':'')+' onclick="EXP_PAGE=Math.min(window._expTotalPages-1,EXP_PAGE+1);renderFullTable()">Next</button>';
}

/* ======= CLASSIFICATIONS (ISCO-3 & ISCO-4, national + regional) ========== */
var CLS_VIEW='national';
function showClassView(v, btn){
  CLS_VIEW=v;
  document.querySelectorAll('#tab-classify .sub-btn').forEach(function(b){ b.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  var n=document.getElementById('cv-national'), r=document.getElementById('cv-region');
  n.classList.toggle('active', v==='national');
  r.classList.toggle('active', v==='region');
  renderClassifications(getRows());
}

function isco3Name(code){
  return (typeof ISCO3_NAMES!=='undefined' && ISCO3_NAMES[code]) || ('ISCO '+code);
}

function renderClassifications(rows){
  if (CLS_VIEW==='national') renderClassNational(rows);
  else                       renderClassRegional(rows);
}

function renderClassNational(rows){
  var total = rows.length;
  var c3 = {};
  rows.forEach(function(r){ if(!isNaN(r[3])) c3[r[3]] = (c3[r[3]]||0)+1; });
  var t3 = Object.keys(c3).map(function(code){
    var c = parseInt(code,10);
    return { code:c, name:isco3Name(c), count:c3[code] };
  }).sort(function(a,b){return b.count-a.count;});
  classBar('isco3-chart', t3.slice(0,12), total, C.teal);
  classTable('isco3-table', t3, total, ['ISCO-3','Minor Group','Postings','Share']);

  var c4 = {}, meta4 = {};
  rows.forEach(function(r){
    var nm = r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; if(!nm) return;
    c4[nm] = (c4[nm]||0)+1;
    if(!meta4[nm]) meta4[nm] = { code:(DATA.isco4CodeByName&&DATA.isco4CodeByName[nm])||'', isco3:r[3] };
  });
  var t4 = Object.keys(c4).map(function(nm){
    return { code:meta4[nm].code, name:nm, isco3:meta4[nm].isco3, count:c4[nm] };
  }).sort(function(a,b){return b.count-a.count;});
  classBar('isco4-chart', t4.slice(0,12), total, C.gold);
  classTable('isco4-table', t4, total, ['ISCO-4','Unit Group','Postings','Share'], true);
}

/* ---- regional classification -------------------------------------------- */
function renderClassRegional(rows){
  /* aggregate: state -> isco3 -> count, and isco3 -> state -> count */
  var byState={}, byRole={}, stateTot={}, roleTot={};
  rows.forEach(function(r){
    if(r[0]<0 || isNaN(r[3])) return;
    var st=DATA.lookup.states[r[0]], code=r[3];
    (byState[st]=byState[st]||{})[code]=(byState[st][code]||0)+1;
    (byRole[code]=byRole[code]||{})[st]=(byRole[code][st]||0)+1;
    stateTot[st]=(stateTot[st]||0)+1;
    roleTot[code]=(roleTot[code]||0)+1;
  });

  var states=Object.keys(stateTot).sort(function(a,b){return stateTot[b]-stateTot[a];});
  var codes=Object.keys(roleTot).sort(function(a,b){return roleTot[b]-roleTot[a];}).slice(0,10);

  /* heatmap: rows = states, cols = ISCO-3, value = % of that state's postings */
  if(!states.length || !codes.length){
    document.getElementById('cls-region-heat').innerHTML='<p class="chart-empty">There is no regional data for this selection.</p>';
  } else {
    var z=states.map(function(st){
      return codes.map(function(c){
        var n=(byState[st]&&byState[st][c])||0;
        return stateTot[st] ? +(n/stateTot[st]*100).toFixed(1) : 0;
      });
    });
    var txt=states.map(function(st){
      return codes.map(function(c){ return String((byState[st]&&byState[st][c])||0); });
    });
    drawChart('cls-region-heat',[{
      type:'heatmap', z:z,
      x:codes.map(function(c){ return codeLabel(c, isco3Name(c), 18); }), y:states,
      text:txt, colorscale:SEQ, xgap:3, ygap:3,
      hovertemplate:'<b>%{y}</b><br>%{x}<br>%{z}% of this state\'s postings (%{text} jobs)<extra></extra>',
      colorbar:{title:{text:'% of state',font:{size:9}},thickness:10,len:0.8,tickfont:{size:9},outlinewidth:0}
    }], {
      xaxis:{side:'top',tickangle:0,tickfont:{size:9,color:PAL.mid},fixedrange:true,automargin:true},
      yaxis:{automargin:true,tickfont:{size:9.5,color:PAL.mid},fixedrange:true},
      margin:{l:8,r:8,t:96,b:8}},
      {title:'Occupational mix by region',
       cols:['State'].concat(codes.map(function(c){ return c+' '+isco3Name(c); })),
       rows:states.map(function(st,i){ return [st].concat(z[i]); })});
  }

  /* concentration: for each ISCO-3, share held by its top state */
  var conc=Object.keys(roleTot).map(function(c){
    var dist=byRole[c]||{}, top=null, n=-1;
    for(var st in dist) if(dist[st]>n){ n=dist[st]; top=st; }
    return { code:parseInt(c,10), name:isco3Name(c), total:roleTot[c], topState:top||'—',
             topN:Math.max(n,0), share: roleTot[c] ? +(Math.max(n,0)/roleTot[c]*100).toFixed(1) : 0,
             nStates:Object.keys(dist).length };
  }).sort(function(a,b){return b.total-a.total;});

  var cs=conc.slice(0,12).slice().sort(function(a,b){return a.share-b.share;});
  if(!cs.length){
    document.getElementById('cls-conc-chart').innerHTML='<p class="chart-empty">There is no data for this selection.</p>';
  } else {
    drawChart('cls-conc-chart',[{type:'bar',orientation:'h',
      y:cs.map(function(d){ return codeLabel(d.code, d.name, 24); }),
      x:cs.map(function(d){return d.share;}),
      customdata:cs.map(function(d){ return [d.code+' · '+d.name, d.topState, d.topN, d.total, d.nStates]; }),
      marker:{color:cs.map(function(d){return d.share>=50?PAL.gold:PAL.teal;}),line:{width:0}},
      text:cs.map(function(d){return d.share+'% in '+d.topState;}),
      textposition:'outside',textfont:{size:10,color:PAL.mid},cliponaxis:false,
      hovertemplate:'<b>%{customdata[0]}</b><br>'+
                    'Top state: %{customdata[1]} with %{customdata[2]:,} of %{customdata[3]:,} postings<br>'+
                    'Present in %{customdata[4]} states<br>%{x}% sits in the top state<extra></extra>'}],
      {xaxis:axV({showticklabels:false,range:[0,128]}),
       yaxis:axC({tickfont:{size:9.5,color:PAL.mid}}),
       bargap:0.28,margin:{l:8,r:132,t:10,b:8}},
      {title:'Regional concentration by occupation',
       cols:['ISCO-3','Minor group','Postings','States present','Top state','Top-state share (%)'],
       rows:conc.map(function(d){ return [d.code,d.name,d.total,d.nStates,d.topState,d.share]; })});
  }

  var h='<table class="data-tbl"><thead><tr><th>ISCO-3</th><th>Minor Group</th><th>Postings</th><th>States Present</th><th>Top State</th><th>Top-State Share</th></tr></thead><tbody>';
  conc.forEach(function(d){
    h+='<tr><td><span class="badge">'+d.code+'</span></td><td><b>'+esc(d.name)+'</b></td>'+
       '<td class="cnt">'+fmt(d.total)+'</td><td>'+d.nStates+'</td><td>'+esc(d.topState)+'</td>'+
       '<td class="'+(d.share>=50?'gld':'')+'">'+d.share+'%</td></tr>';
  });
  document.getElementById('cls-conc-table').innerHTML=h+'</tbody></table>';

  /* region profile selector */
  var sel=document.getElementById('cls-state');
  if(sel && sel.dataset.filled!=='1'){
    sel.innerHTML=DATA.lookup.states.map(function(s){return '<option value="'+esc(s)+'">'+esc(s)+'</option>';}).join('');
    sel.dataset.filled='1';
  }
  renderRegionProfile();
}

function renderRegionProfile(){
  var sel=document.getElementById('cls-state'); if(!sel) return;
  var st=sel.value || DATA.lookup.states[0];
  var si=DATA.lookup.states.indexOf(st);
  var rows=getRows().filter(function(r){ return r[0]===si; });
  var total=rows.length;

  var c3={};
  rows.forEach(function(r){ if(!isNaN(r[3])) c3[r[3]]=(c3[r[3]]||0)+1; });
  var t3=Object.keys(c3).map(function(c){ return {code:parseInt(c,10),name:isco3Name(c),count:c3[c]}; })
    .sort(function(a,b){return b.count-a.count;});

  var c4={},m4={};
  rows.forEach(function(r){
    var nm=r[4]>=0?DATA.lookup.isco4[r[4]]:null; if(!nm) return;
    c4[nm]=(c4[nm]||0)+1;
    if(!m4[nm]) m4[nm]={code:(DATA.isco4CodeByName&&DATA.isco4CodeByName[nm])||'',isco3:r[3]};
  });
  var t4=Object.keys(c4).map(function(nm){ return {code:m4[nm].code,name:nm,isco3:m4[nm].isco3,count:c4[nm]}; })
    .sort(function(a,b){return b.count-a.count;});

  if(!total){
    var msg='<p style="padding:12px;color:#7A9C9C;font-size:11px">No postings for '+esc(st)+' under the current filters.</p>';
    document.getElementById('cls-rp-isco3').innerHTML=msg;
    document.getElementById('cls-rp-isco4').innerHTML=msg;
    return;
  }
  classTable('cls-rp-isco3', t3, total, ['ISCO-3','Minor Group','Postings','Share of '+st]);
  classTable('cls-rp-isco4', t4, total, ['ISCO-4','Unit Group','Postings','Share of '+st], true);
}

function classBar(id, arr, total, col){
  hBar(id, arr.map(function(d){ return { label:d.name, code:d.code, count:d.count }; }),
       { total:total, color:col, wrap:26, ofWhat:'in-scope postings',
         title:(col===PAL.gold?'ISCO-4 unit groups':'ISCO-3 minor groups') });
}
function classTable(id, arr, total, heads, withParent){
  var html='<table class="data-tbl"><thead><tr>'+heads.map(function(h){return '<th>'+esc(h)+'</th>';}).join('')+
    (withParent?'<th>Parent ISCO-3</th>':'')+'</tr></thead><tbody>';
  arr.forEach(function(d){
    html+='<tr><td><span class="badge'+(withParent?' badge-g':'')+'">'+esc(String(d.code||'—'))+'</span></td>'+
      '<td><b>'+esc(d.name)+'</b></td><td class="cnt">'+fmt(d.count)+'</td>'+
      '<td class="num">'+pct(d.count,total)+'%</td>'+
      (withParent?'<td class="num">'+esc(String(d.isco3||'—'))+'</td>':'')+'</tr>';
  });
  document.getElementById(id).innerHTML=html+'</tbody></table>';
}

/* ============================================================================
   TOP TIERS — ranked "top 20 / 30 / 50" analysis, split across five sub-views
   so that no single page has to carry everything.
   ============================================================================ */
var TIER_N = 20, TIER_VIEW = 'occ';

function setTierN(n, btn){
  TIER_N = n;
  document.querySelectorAll('#tier-n button').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderTiers();
}
function showTierView(v, btn){
  TIER_VIEW = v;
  document.querySelectorAll('#tab-tiers .sub-tab-nav .sub-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  ['occ','title','region','employer','sector'].forEach(function(k){
    var el = document.getElementById('tv-'+k);
    if (el) el.classList.toggle('active', k===v);
  });
  renderTiers();
}

/* Rank a map of label -> count into a sorted, cumulative-share array. */
function rankOf(counts, total){
  var arr = Object.keys(counts).map(function(k){ return { label:k, count:counts[k] }; })
              .sort(function(a,b){ return b.count - a.count; });
  var run = 0;
  arr.forEach(function(d){
    d.share = total ? +(d.count/total*100).toFixed(2) : 0;
    run += d.count;
    d.cum = total ? +(run/total*100).toFixed(1) : 0;
  });
  return arr;
}
/* Given rows, return the most common decoded value for a set of row indices. */
function leadBy(rowsSubset, pick){
  var c = {};
  rowsSubset.forEach(function(r){ var v = pick(r); if (v) c[v] = (c[v]||0)+1; });
  return topKeyOf(c) || '—';
}

function renderTiers(){
  if (!DATA) return;
  var rows = getRows();
  var el = document.getElementById('tier-intro');
  if (el) el.innerHTML =
    'This tab ranks the '+esc(APP.sector.label.toLowerCase())+' market from the top down, so that the entries worth acting on '+
    'sit at the front. The five views below cover the standardised occupations, the job titles employers actually advertise, '+
    'the regions, the named employers, and the employer sectors. All of them are computed from the '+fmt(rows.length)+
    ' postings currently passing the header filters, and every chart and table can be exported.';

  if (TIER_VIEW==='occ')      tierOccupations(rows);
  if (TIER_VIEW==='title')    tierTitles(rows);
  if (TIER_VIEW==='region')   tierRegions(rows);
  if (TIER_VIEW==='employer') tierEmployers(rows);
  if (TIER_VIEW==='sector')   tierSectors(rows);
}

/* ---- 1. Occupations (ISCO-4) --------------------------------------------- */
function tierOccupations(rows){
  var total = rows.length, c = {};
  rows.forEach(function(r){ var l = r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; if (l) c[l] = (c[l]||0)+1; });
  var ranked = rankOf(c, total);
  var top = ranked.slice(0, TIER_N);

  hBar('tier-occ-bar', top.map(function(d){
    return { label:d.label, code:(DATA.isco4CodeByName&&DATA.isco4CodeByName[d.label])||'', count:d.count };
  }), { total:total, color:PAL.teal, wrap:30, ofWhat:'in-scope postings',
        title:'Top '+TIER_N+' occupations (ISCO-4)' });

  pareto('tier-occ-pareto', top, total, 'Occupations ranked by share, with cumulative demand');

  var byOcc = {};
  rows.forEach(function(r){ var l = r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; if (!l) return; (byOcc[l]=byOcc[l]||[]).push(r); });
  var h = '<table class="data-tbl"><thead><tr><th>Rank</th><th>ISCO-4</th><th>Occupation</th><th>Parent ISCO-3</th>'+
          '<th>Postings</th><th>Share</th><th>Cumulative</th><th>Leading employer sector</th><th>Leading region</th></tr></thead><tbody>';
  top.forEach(function(d, i){
    var sub = byOcc[d.label] || [];
    var code = (DATA.isco4CodeByName&&DATA.isco4CodeByName[d.label]) || '—';
    var parent = sub.length ? sub[0][3] : '';
    h += '<tr><td class="num">'+(i+1)+'</td>'+
         '<td><span class="badge">'+esc(String(code))+'</span></td>'+
         '<td><b>'+esc(d.label)+'</b></td>'+
         '<td>'+esc(String(parent||'—'))+' '+esc(isco3Name(parent))+'</td>'+
         '<td class="cnt">'+fmt(d.count)+'</td><td class="num">'+d.share.toFixed(1)+'%</td>'+
         '<td class="num gld">'+d.cum+'%</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[1]>=0 ? DATA.lookup.isic[r[1]] : null; }))+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[0]>=0 ? DATA.lookup.states[r[0]] : null; }))+'</td></tr>';
  });
  document.getElementById('tier-occ-table').innerHTML = h + '</tbody></table>';
}

/* ---- 2. Advertised job titles -------------------------------------------- */
function tierTitles(rows){
  ensureIdx();
  var total = rows.length, c = {}, byTitle = {};
  rows.forEach(function(r){
    var t = (DATA.raw.title[_rowToIdx.get(r)] || '').trim();
    if (!t || t==='—') return;
    c[t] = (c[t]||0)+1;
    (byTitle[t]=byTitle[t]||[]).push(r);
  });
  var ranked = rankOf(c, total), top = ranked.slice(0, TIER_N);

  hBar('tier-title-bar', top.map(function(d){ return { label:d.label, count:d.count }; }),
       { total:total, color:PAL.tealD, wrap:30, ofWhat:'in-scope postings',
         title:'Top '+TIER_N+' advertised job titles' });

  var h = '<table class="data-tbl"><thead><tr><th>Rank</th><th>Advertised job title</th><th>Postings</th><th>Share</th>'+
          '<th>Classified as (ISCO-4)</th><th>Leading employer sector</th></tr></thead><tbody>';
  top.forEach(function(d, i){
    var sub = byTitle[d.label] || [];
    var occ = leadBy(sub, function(r){ return r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; });
    var code = (DATA.isco4CodeByName&&DATA.isco4CodeByName[occ]) || '';
    h += '<tr><td class="num">'+(i+1)+'</td><td><b>'+esc(d.label)+'</b></td>'+
         '<td class="cnt">'+fmt(d.count)+'</td><td class="num">'+d.share.toFixed(1)+'%</td>'+
         '<td>'+(code?'<span class="badge badge-g">'+esc(String(code))+'</span> ':'')+esc(occ)+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[1]>=0 ? DATA.lookup.isic[r[1]] : null; }))+'</td></tr>';
  });
  document.getElementById('tier-title-table').innerHTML = h + '</tbody></table>';
}

/* ---- 3. Regions ----------------------------------------------------------- */
function tierRegions(rows){
  var total = rows.length, c = {}, byState = {};
  rows.forEach(function(r){
    if (r[0]<0) return;
    var s = DATA.lookup.states[r[0]];
    c[s] = (c[s]||0)+1;
    (byState[s]=byState[s]||[]).push(r);
  });
  var ranked = rankOf(c, total), top = ranked.slice(0, TIER_N);
  pareto('tier-region-pareto', top, total, 'Regions ranked by share, with cumulative demand');

  /* grouped bars: leading occupations inside each leading region */
  var topStates = top.slice(0, 8).map(function(d){ return d.label; });
  var occCount = {};
  rows.forEach(function(r){ var l = r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; if (l) occCount[l]=(occCount[l]||0)+1; });
  var topOccs = Object.keys(occCount).sort(function(a,b){ return occCount[b]-occCount[a]; }).slice(0,5);
  var el = document.getElementById('tier-region-mix');
  if (!topStates.length || !topOccs.length){
    el.innerHTML = '<p class="chart-empty">There is no regional data for this selection.</p>';
  } else {
    var traces = topOccs.map(function(occ, i){
      return { type:'bar', name:occ,
        x: topStates,
        y: topStates.map(function(st){
             return (byState[st]||[]).filter(function(r){ return r[4]>=0 && DATA.lookup.isco4[r[4]]===occ; }).length; }),
        marker:{ color: CAT[i % CAT.length] },
        hovertemplate:'<b>%{x}</b><br>%{y:,} postings<extra><b>'+occ+'</b></extra>' };
    });
    drawChart('tier-region-mix', traces, {
      barmode:'group', showlegend:true,
      xaxis:axC({tickangle:0}),
      yaxis:axV({title:{text:'Postings',font:{size:10,color:PAL.soft}}}),
      legend:{orientation:'h',y:-0.28,font:{size:9.5,color:PAL.mid}},
      margin:{l:48,r:8,t:10,b:96}
    }, { title:'Leading occupations within the top regions',
         cols:['Region'].concat(topOccs),
         rows: topStates.map(function(st){
           return [st].concat(topOccs.map(function(occ){
             return (byState[st]||[]).filter(function(r){ return r[4]>=0 && DATA.lookup.isco4[r[4]]===occ; }).length; })); }) });
  }

  var h = '<table class="data-tbl"><thead><tr><th>Rank</th><th>Region</th><th>Postings</th><th>Share</th><th>Cumulative</th>'+
          '<th>Leading occupation</th><th>Leading employer sector</th></tr></thead><tbody>';
  top.forEach(function(d, i){
    var sub = byState[d.label] || [];
    h += '<tr><td class="num">'+(i+1)+'</td><td><b>'+esc(d.label)+'</b></td>'+
         '<td class="cnt">'+fmt(d.count)+'</td><td class="num">'+d.share.toFixed(1)+'%</td>'+
         '<td class="num gld">'+d.cum+'%</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; }))+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[1]>=0 ? DATA.lookup.isic[r[1]] : null; }))+'</td></tr>';
  });
  document.getElementById('tier-region-table').innerHTML = h + '</tbody></table>';
}

/* ---- 4. Employers --------------------------------------------------------- */
function tierEmployers(rows){
  ensureIdx();
  var total = rows.length, c = {}, byCo = {};
  rows.forEach(function(r){
    var n = (DATA.raw.company[_rowToIdx.get(r)] || '').trim();
    if (!n || n==='—') return;
    c[n] = (c[n]||0)+1;
    (byCo[n]=byCo[n]||[]).push(r);
  });
  var ranked = rankOf(c, total), top = ranked.slice(0, TIER_N);

  hBar('tier-emp-bar', top.map(function(d){
    var sub = byCo[d.label] || [];
    var sec = leadBy(sub, function(r){ return r[1]>=0 ? DATA.lookup.isic[r[1]] : null; });
    return { label:d.label, count:d.count, color:isicColor(sec) };
  }), { total:total, pct:false, wrap:30, ofWhat:'in-scope postings',
        title:'Top '+TIER_N+' employers by postings' });

  var h = '<table class="data-tbl"><thead><tr><th>Rank</th><th>Employer</th><th>Postings</th><th>Share</th>'+
          '<th>Employer sector</th><th>Leading occupation</th><th>Leading region</th></tr></thead><tbody>';
  top.forEach(function(d, i){
    var sub = byCo[d.label] || [];
    h += '<tr><td class="num">'+(i+1)+'</td><td><b>'+esc(d.label)+'</b></td>'+
         '<td class="cnt">'+fmt(d.count)+'</td><td class="num">'+d.share.toFixed(1)+'%</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[1]>=0 ? DATA.lookup.isic[r[1]] : null; }))+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; }))+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[0]>=0 ? DATA.lookup.states[r[0]] : null; }))+'</td></tr>';
  });
  document.getElementById('tier-emp-table').innerHTML = h + '</tbody></table>';
}

/* ---- 5. Employer sectors -------------------------------------------------- */
function tierSectors(rows){
  ensureIdx();
  var total = rows.length, c = {}, bySec = {};
  rows.forEach(function(r){
    if (r[1]<0) return;
    var s = DATA.lookup.isic[r[1]];
    c[s] = (c[s]||0)+1;
    (bySec[s]=bySec[s]||[]).push(r);
  });
  var ranked = rankOf(c, total), top = ranked.slice(0, TIER_N);

  hBar('tier-sector-bar', top.map(function(d){
    return { label:d.label, count:d.count, color:isicColor(d.label) };
  }), { total:total, wrap:26, ofWhat:'in-scope postings',
        title:'Employer sectors ranked by postings' });

  /* sector x region, row-normalised */
  var secs = top.slice(0, 10).map(function(d){ return d.label; });
  var stateTot = {};
  rows.forEach(function(r){ if (r[0]>=0) stateTot[DATA.lookup.states[r[0]]] = 1; });
  var states = Object.keys(stateTot);
  var el = document.getElementById('tier-sector-geo');
  if (!secs.length || !states.length){
    el.innerHTML = '<p class="chart-empty">There is no regional data for this selection.</p>';
  } else {
    var z = secs.map(function(s){
      var sub = bySec[s] || [];
      return states.map(function(st){
        var n = sub.filter(function(r){ return r[0]>=0 && DATA.lookup.states[r[0]]===st; }).length;
        return sub.length ? +(n/sub.length*100).toFixed(1) : 0;
      });
    });
    drawChart('tier-sector-geo', [{
      type:'heatmap', z:z, x:states, y:secs.map(function(s){ return wrapLabel(s, 22); }),
      colorscale:SEQ, xgap:3, ygap:3,
      hovertemplate:'<b>%{y}</b><br>%{x}<br>%{z}% of this sector\'s postings<extra></extra>',
      colorbar:{title:{text:'% of sector',font:{size:9}},thickness:10,len:0.8,tickfont:{size:9},outlinewidth:0}
    }], {
      xaxis:{tickangle:-30,tickfont:{size:9,color:PAL.mid},fixedrange:true,automargin:true},
      yaxis:{automargin:true,tickfont:{size:9,color:PAL.mid},fixedrange:true},
      margin:{l:8,r:8,t:10,b:8}
    }, { title:'Employer sector by region', cols:['Employer sector'].concat(states),
         rows: secs.map(function(s,i){ return [s].concat(z[i]); }) });
  }

  var h = '<table class="data-tbl"><thead><tr><th>Rank</th><th>Employer sector</th><th>Postings</th><th>Share</th>'+
          '<th>Cumulative</th><th>Distinct employers</th><th>Leading occupation</th><th>Leading region</th></tr></thead><tbody>';
  top.forEach(function(d, i){
    var sub = bySec[d.label] || [];
    var cos = {};
    sub.forEach(function(r){ var n = DATA.raw.company[_rowToIdx.get(r)]; if (n && n!=='—') cos[n]=1; });
    h += '<tr><td class="num">'+(i+1)+'</td><td><b>'+esc(d.label)+'</b></td>'+
         '<td class="cnt">'+fmt(d.count)+'</td><td class="num">'+d.share.toFixed(1)+'%</td>'+
         '<td class="num gld">'+d.cum+'%</td>'+
         '<td class="num">'+fmt(Object.keys(cos).length)+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; }))+'</td>'+
         '<td>'+esc(leadBy(sub, function(r){ return r[0]>=0 ? DATA.lookup.states[r[0]] : null; }))+'</td></tr>';
  });
  document.getElementById('tier-sector-table').innerHTML = h + '</tbody></table>';
}

/* ---- shared Pareto (bars + cumulative line) ------------------------------- */
function pareto(id, ranked, total, title){
  var el = document.getElementById(id);
  if (!el) return;
  if (!ranked.length){ el.innerHTML = '<p class="chart-empty">There is no data for this selection.</p>'; return; }
  var labels = ranked.map(function(d){ return wrapLabel(d.label, 16); });
  drawChart(id, [
    { type:'bar', name:'Share of postings', x:labels, y:ranked.map(function(d){ return d.share; }),
      marker:{ color:PAL.teal, line:{width:0} },
      customdata:ranked.map(function(d){ return [d.label, d.count]; }),
      hovertemplate:'<b>%{customdata[0]}</b><br>%{customdata[1]:,} postings<br>%{y:.1f}% of all postings<extra></extra>' },
    { type:'scatter', name:'Cumulative share', mode:'lines+markers', yaxis:'y2',
      x:labels, y:ranked.map(function(d){ return d.cum; }),
      line:{ color:PAL.gold, width:2 }, marker:{ color:PAL.gold, size:4 },
      customdata:ranked.map(function(d){ return [d.label]; }),
      hovertemplate:'<b>%{customdata[0]}</b><br>%{y:.1f}% of demand covered up to here<extra></extra>' }
  ], {
    showlegend:true,
    legend:{ orientation:'h', y:-0.42, font:{ size:9.5, color:PAL.mid } },
    xaxis:axC({ tickangle:-32, tickfont:{ size:8.5, color:PAL.mid } }),
    yaxis:axV({ title:{ text:'Share of postings (%)', font:{ size:9.5, color:PAL.soft } } }),
    yaxis2:{ overlaying:'y', side:'right', range:[0,105], showgrid:false,
             tickfont:{ size:9, color:PAL.gold }, ticksuffix:'%', fixedrange:true,
             title:{ text:'Cumulative (%)', font:{ size:9.5, color:PAL.gold } } },
    margin:{ l:50, r:52, t:10, b:110 }
  }, { title:title, cols:['Rank','Name','Postings','Share (%)','Cumulative (%)'],
       rows: ranked.map(function(d,i){ return [i+1, d.label, d.count, d.share, d.cum]; }) });
}

/* ======= STATIC (per-sector) TABS ======================================== */
function buildStaticTabs(){
  var tabs=(APP.sector.staticTabs||[]);
  if(!tabs.length) return;
  var nav=document.getElementById('tab-nav');
  var mount=document.getElementById('static-tabs');
  tabs.forEach(function(t){
    var btn=document.createElement('button');
    btn.className='tab-btn'; btn.textContent=t.label;
    btn.onclick=function(){ showTab(t.id,btn); };
    nav.appendChild(btn);

    var sec=document.createElement('section');
    sec.id='tab-'+t.id; sec.className='tab-panel';
    sec.innerHTML='<div class="insight-box">Loading…</div>';
    mount.appendChild(sec);

    fetch(t.file).then(function(r){ if(!r.ok) throw new Error(r.status); return r.text(); })
      .then(function(html){ sec.innerHTML=html; })
      .catch(function(){ sec.innerHTML='<div class="alert-box">Could not load <code>'+esc(t.file)+'</code>. If testing locally, serve over http.</div>'; });
  });
}

/* Sub-tab switcher used by injected Qualifications content (onclick="showQualsRole(...)"). */
function showQualsRole(code, btn){
  var scope=document.getElementById('tab-quals'); if(!scope) return;
  scope.querySelectorAll('.sub-btn').forEach(function(b){ b.classList.remove('active'); });
  scope.querySelectorAll('.sub-panel').forEach(function(p){ p.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  var p=document.getElementById('qpanel-'+code); if(p) p.classList.add('active');
}
