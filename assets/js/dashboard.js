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

/* ======= PALETTE / PLOTLY BASE ========================================== */
var C = { teal:'#1A7B7A', tealD:'#0F5B5A', tealL:'#E5F2F2', gold:'#D4940A',
          textD:'#0F2E2E', textM:'#3D6060', textL:'#7A9C9C', border:'#D4E5E5',
          coral:'#D94F3D', teal2:'#2D9B9A',
          emp:['#1A7B7A','#4AABAA','#B8D9D9','#D4940A','#E8A820','#0F5B5A'] };
var ISIC_PALETTE = ['#1A7B7A','#D4940A','#2D9B9A','#E8A820','#0F5B5A','#B8D9D9',
                    '#4AABAA','#C4880C','#3B6E8F','#7FBFBF'];
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
var TREND_COLS = ['#1A7B7A','#D4940A','#2D9B9A','#0F5B5A','#E8A820'];

var pc   = { displayModeBar:false, responsive:true };
var base = { paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
             font:{family:"'Outfit',sans-serif",color:C.textD,size:11},
             margin:{l:8,r:8,t:12,b:8},
             hoverlabel:{bgcolor:'#fff',bordercolor:C.border,font:{family:'Outfit',size:12,color:C.textD}} };
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
    ['In-scope '+s.label+' Postings', fmt(m.total)],
    ['Classification', 'ISCO-08 (ILO) · Employer sector (ISIC Rev.4)']
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
  if (id==='feasibility') renderFeasibility(rows);
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
  if (APP.activeTab==='feasibility') renderFeasibility(rows);
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
  kpi('kpi-lead', pct(leadN,total)+'%', (lead? shortName(lead.name):'Lead')+' Roles', fmt(leadN)+' postings — largest role group');
  kpi('kpi-parttime', pct(pt,total)+'%', 'Open to Part-time', 'Accept flexible or part-time arrangements');
  kpi('kpi-geo', top3p+'%', 'Demand in Top 3 States', 'Led by '+topSt+': geographic concentration of demand');
}
function shortName(n){ return n.length>22 ? n.slice(0,20)+'…' : n; }

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
  var s=Object.keys(c).map(function(k){return [k,c[k]];}).sort(function(a,b){return b[1]-a[1];}).slice(0,10).reverse();
  Plotly.react('chart-top10',[{type:'bar',orientation:'h',
    y:s.map(function(d){return d[0];}), x:s.map(function(d){return +(d[1]/Math.max(total,1)*100).toFixed(1);}),
    marker:{color:C.teal,line:{width:0}},
    text:s.map(function(d){return (d[1]/Math.max(total,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}% of demand<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      bargap:0.3,margin:{l:8,r:52,t:12,b:8}}),pc);
}

/* ======= EMPLOYER BAR ===================================================== */
function renderIsicBar(rows){
  var total=rows.length, c={};
  rows.forEach(function(r){ if(r[1]>=0){ var cat=DATA.lookup.isic[r[1]]; c[cat]=(c[cat]||0)+1; } });
  var s=Object.keys(c).map(function(k){return [k,c[k]];}).sort(function(a,b){return a[1]-b[1];});
  Plotly.react('chart-isic',[{type:'bar',orientation:'h',
    y:s.map(function(d){return d[0];}), x:s.map(function(d){return +(d[1]/Math.max(total,1)*100).toFixed(1);}),
    marker:{color:s.map(function(d){return isicColor(d[0]);}),line:{width:0}},
    text:s.map(function(d){return (d[1]/Math.max(total,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}%<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      bargap:0.3,margin:{l:8,r:52,t:12,b:8}}),pc);
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
  Plotly.react('chart-cross',[{type:'heatmap',
    x:grps.map(function(g){return g.name;}), y:isicList, z:zData,
    colorscale:[[0,'#EAF4F4'],[0.3,'#4DB8B8'],[0.65,'#1A7B7A'],[1,'#0A3D3D']],
    showscale:true,
    colorbar:{thickness:10,len:0.85,tickfont:{size:9,family:'Outfit'},ticksuffix:'%',outlinewidth:0},
    hovertemplate:'<b>%{y}</b><br>%{x}: %{z:.1f}%<extra></extra>', xgap:4, ygap:4}],
    Object.assign({},base,{xaxis:{showgrid:false,tickfont:{size:9},fixedrange:true,tickangle:0},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      annotations:annotations, margin:{l:8,r:60,t:16,b:36}}),pc);
}
function wrapName(n){
  var w=n.split(' '); if(w.length<2) return n;
  var mid=Math.ceil(w.length/2);
  return w.slice(0,mid).join(' ')+'<br>'+w.slice(mid).join(' ');
}

/* ======= TREND CHART ====================================================== */
function renderTrend(rows){
  var wl=DATA.lookup.weekLabels;
  if(!wl.length){ Plotly.react('chart-trend',[],Object.assign({},base)); return; }
  /* top ISCO-2 groups present (up to 5) */
  var c2={}; rows.forEach(function(r){ if(r[2]>0) c2[r[2]]=(c2[r[2]]||0)+1; });
  var groups=Object.keys(c2).map(function(k){return parseInt(k,10);})
    .sort(function(a,b){return c2[b]-c2[a];}).slice(0,5);
  var traces=groups.map(function(i2,gi){
    var y=Array(wl.length).fill(0);
    rows.forEach(function(r){ if(r[2]===i2 && r[7]>=0) y[r[7]]++; });
    var nm=(ISCO2_NAMES[i2]||('ISCO '+i2))+' ('+i2+')';
    var col=TREND_COLS[gi%TREND_COLS.length];
    return {x:wl,y:y,type:'scatter',mode:'lines+markers',name:nm,
      line:{color:col,width:2.5,shape:'spline'},marker:{color:col,size:5},
      fill:'tozeroy',fillcolor:col+'18',
      hovertemplate:'<b>%{x}</b><br>'+nm+': %{y:,d}<extra></extra>'};
  });
  Plotly.react('chart-trend',traces,Object.assign({},base,{
    xaxis:{showgrid:false,tickfont:{size:10},fixedrange:true},
    yaxis:{showgrid:true,gridcolor:C.border,title:{text:'Postings',font:{size:10}},tickfont:{size:10},fixedrange:true},
    legend:{orientation:'h',y:-0.32,font:{size:9},bgcolor:'rgba(0,0,0,0)'},
    margin:{l:44,r:8,t:12,b:84}}),pc);
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
  kpi('rk3-'+code, topEmp.length>28?topEmp.slice(0,26)+'…':topEmp,'Top Employer Sector','Largest hiring sector for this group');
  kpi('rk4-'+code, topSt,'Top State','Highest posting volume state for this group');

  /* Top ISCO-4 */
  var ic4={}; sub.forEach(function(r){ var l=DATA.lookup.isco4[r[4]]; if(l&&l!=='Other') ic4[l]=(ic4[l]||0)+1; });
  var s4=Object.keys(ic4).map(function(k){return [k,ic4[k]];}).sort(function(a,b){return b[1]-a[1];})
    .slice(0,10).filter(function(d){return +(d[1]/Math.max(tot,1)*100).toFixed(1)>0;}).reverse();
  Plotly.react('rc-top-'+code,[{type:'bar',orientation:'h',
    y:s4.map(function(d){return d[0];}), x:s4.map(function(d){return +(d[1]/Math.max(tot,1)*100).toFixed(1);}),
    marker:{color:g.color,line:{width:0}},
    text:s4.map(function(d){return (d[1]/Math.max(tot,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}%<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      bargap:0.3,margin:{l:8,r:52,t:12,b:8}}),pc);

  /* Contract type */
  var ec={}; sub.forEach(function(r){ ec[r[5]]=(ec[r[5]]||0)+1; });
  var ev=DATA.lookup.empTypes.map(function(l,i){ return {label:l,count:ec[i]||0,col:C.emp[i%C.emp.length]}; })
    .filter(function(d){return d.count>0;}).sort(function(a,b){return a.count-b.count;});
  Plotly.react('rc-emp-'+code,[{type:'bar',orientation:'h',
    y:ev.map(function(d){return d.label;}), x:ev.map(function(d){return +(d.count/Math.max(tot,1)*100).toFixed(1);}),
    marker:{color:ev.map(function(d){return d.col;}),line:{width:0}},
    text:ev.map(function(d){return (d.count/Math.max(tot,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}%<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      bargap:0.35,margin:{l:8,r:52,t:12,b:8}}),pc);

  /* Employer sectors */
  var se=Object.keys(isicc).map(function(k){return [k,isicc[k]];}).sort(function(a,b){return a[1]-b[1];});
  Plotly.react('rc-isic-'+code,[{type:'bar',orientation:'h',
    y:se.map(function(d){return d[0];}), x:se.map(function(d){return +(d[1]/Math.max(tot,1)*100).toFixed(1);}),
    marker:{color:se.map(function(d){return isicColor(d[0]);}),line:{width:0}},
    text:se.map(function(d){return (d[1]/Math.max(tot,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}%<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      bargap:0.3,margin:{l:8,r:52,t:12,b:8}}),pc);

  /* Top companies (pre-computed) */
  var cos=(DATA.companies[String(code)]||[]).slice(0,15).sort(function(a,b){return a.count-b.count;});
  if(cos.length) Plotly.react('rc-cos-'+code,[{type:'bar',orientation:'h',
    y:cos.map(function(d){return d.name;}), x:cos.map(function(d){return d.count;}),
    marker:{color:cos.map(function(d){return isicColor(d.isic);}),line:{width:0}},
    text:cos.map(function(d){return fmt(d.count);}),textposition:'outside',
    textfont:{size:9,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:,d} postings<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:9},fixedrange:true},
      bargap:0.28,margin:{l:8,r:52,t:12,b:8}}),pc);
  else document.getElementById('rc-cos-'+code).innerHTML='<p style="padding:12px;color:#7A9C9C;font-size:11px">No company-level data available.</p>';

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
  var s=Object.keys(c).map(function(k){return [k,c[k]];}).sort(function(a,b){return a[1]-b[1];});
  Plotly.react('chart-states',[{type:'bar',orientation:'h',
    y:s.map(function(d){return d[0];}), x:s.map(function(d){return +(d[1]/Math.max(tot,1)*100).toFixed(1);}),
    marker:{color:C.teal,line:{width:0}},
    text:s.map(function(d){return (d[1]/Math.max(tot,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}% of postings<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:10},fixedrange:true},
      bargap:0.3,margin:{l:8,r:52,t:12,b:8}}),pc);
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
  if(!_rowToIdx){ _rowToIdx=new Map(); DATA.rows.forEach(function(r,i){ _rowToIdx.set(r,i); }); }
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
      '<td class="desc-cell">'+esc(d.desc)+'</td>'+
      '<td class="desc-cell">'+esc(d.req)+'</td>'+
      '<td class="desc-cell">'+esc(d.benefits)+'</td>'+
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

/* ======= CLASSIFICATIONS (ISCO-3 & ISCO-4, separate) ===================== */
function renderClassifications(rows){
  var total = rows.length;
  /* ISCO-3 */
  var c3 = {};
  rows.forEach(function(r){ if(!isNaN(r[3])) c3[r[3]] = (c3[r[3]]||0)+1; });
  var t3 = Object.keys(c3).map(function(code){
    var c = parseInt(code,10);
    return { code:c, name:(typeof ISCO3_NAMES!=='undefined'&&ISCO3_NAMES[c])||('ISCO '+c), count:c3[code] };
  }).sort(function(a,b){return b.count-a.count;});
  classBar('isco3-chart', t3.slice(0,12), total, C.teal);
  classTable('isco3-table', t3, total, ['ISCO-3','Minor Group','Postings','Share']);

  /* ISCO-4 */
  var c4 = {}, meta4 = {};
  rows.forEach(function(r){
    var nm = r[4]>=0 ? DATA.lookup.isco4[r[4]] : null; if(!nm) return;
    c4[nm] = (c4[nm]||0)+1;
    if(!meta4[nm]) meta4[nm] = { code: (DATA.isco4CodeByName&&DATA.isco4CodeByName[nm]) || '', isco3: r[3] };
  });
  var t4 = Object.keys(c4).map(function(nm){
    return { code:meta4[nm].code, name:nm, isco3:meta4[nm].isco3, count:c4[nm] };
  }).sort(function(a,b){return b.count-a.count;});
  classBar('isco4-chart', t4.slice(0,12).map(function(d){return {code:d.code,name:d.name,count:d.count};}), total, C.gold);
  classTable('isco4-table', t4, total, ['ISCO-4','Unit Group','Postings','Share'], true);
}
function classBar(id, arr, total, col){
  var s = arr.slice().sort(function(a,b){return a.count-b.count;});
  Plotly.react(id,[{type:'bar',orientation:'h',
    y:s.map(function(d){return (d.code?d.code+' ':'')+shortName(d.name);}),
    x:s.map(function(d){return +(d.count/Math.max(total,1)*100).toFixed(1);}),
    marker:{color:col,line:{width:0}},
    text:s.map(function(d){return (d.count/Math.max(total,1)*100).toFixed(1)+'%';}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:.1f}%<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:9},fixedrange:true},
      bargap:0.3,margin:{l:8,r:48,t:8,b:8}}),pc);
}
function classTable(id, arr, total, heads, withParent){
  var html='<table class="data-tbl"><thead><tr>'+heads.map(function(h){return '<th>'+esc(h)+'</th>';}).join('')+
    (withParent?'<th>Parent ISCO-3</th>':'')+'</tr></thead><tbody>';
  arr.forEach(function(d){
    html+='<tr><td><span class="badge">'+esc(String(d.code||'—'))+'</span></td>'+
      '<td><b>'+esc(d.name)+'</b></td><td class="cnt">'+fmt(d.count)+'</td>'+
      '<td>'+pct(d.count,total)+'%</td>'+
      (withParent?'<td>'+esc(String(d.isco3||'—'))+'</td>':'')+'</tr>';
  });
  document.getElementById(id).innerHTML=html+'</tbody></table>';
}

/* ======= FEASIBILITY (visa signal) + SOURCES ============================= */
function ensureRowIndex(){ if(!_rowToIdx){ _rowToIdx=new Map(); DATA.rows.forEach(function(r,i){ _rowToIdx.set(r,i); }); } }

function renderFeasibility(rows){
  ensureRowIndex();
  var total=rows.length;
  var visaN=0, reloN=0, byRole={}, bySector={}, examples=[];
  rows.forEach(function(r){
    var i=_rowToIdx.get(r);
    var v = r[8]===1, relo = DATA.raw.relo[i]===1;
    if(v){ visaN++;
      byRole[r[3]]=(byRole[r[3]]||0)+1;
      if(r[1]>=0){ var sec=DATA.lookup.isic[r[1]]; bySector[sec]=(bySector[sec]||0)+1; }
      if(examples.length<12) examples.push({ title:DATA.raw.title[i], company:DATA.raw.company[i],
        hit:DATA.raw.visaHit[i], snippet:snip(DATA.raw.desc[i]+' '+DATA.raw.req[i]+' '+DATA.raw.benefits[i], DATA.raw.visaHit[i]) });
    }
    if(relo) reloN++;
  });
  var secN=Object.keys(bySector).length;
  kpi('visa-k1', pct(visaN,total)+'%','Mention Visa Sponsorship', fmt(visaN)+' of '+fmt(total)+' filtered postings');
  kpi('visa-k2', fmt(visaN),'Visa Mentions (count)','Text-mined from posting body');
  kpi('visa-k3', pct(reloN,total)+'%','Mention Relocation','Softer international-openness signal');
  kpi('visa-k4', fmt(secN),'Employer Sectors w/ Visa','Sectors with at least one visa mention');

  var verdict;
  if (visaN===0) verdict='<b>Feasibility verdict:</b> The extractor ran over <b>'+fmt(total)+'</b> postings and found <b>no</b> explicit visa-sponsorship language. That is itself a finding: on StepStone Germany, visa sponsorship is very rarely stated in the ad text, so this metric is <b>extractable but low-yield</b> — a near-absence signal consistent with the domestic-hiring framing of these listings. Relocation language ('+pct(reloN,total)+'%) is a more common proxy for international openness.';
  else if (parseFloat(pct(visaN,total))<3) verdict='<b>Feasibility verdict:</b> Visa language is <b>extractable but rare</b> ('+pct(visaN,total)+'% of postings). The signal works and can be tracked over time, but base rates are low — treat it as a scarcity indicator rather than a volume metric, and pair it with the relocation signal ('+pct(reloN,total)+'%).';
  else verdict='<b>Feasibility verdict:</b> Visa language is <b>reliably extractable</b> at '+pct(visaN,total)+'% of postings — a usable, trackable metric. Cross-check a sample against the audit table below before treating it as ground truth.';
  document.getElementById('visa-verdict').innerHTML=verdict;

  featBar('visa-by-role', Object.keys(byRole).map(function(k){
    return { name:(typeof ISCO3_NAMES!=='undefined'&&ISCO3_NAMES[k])||('ISCO '+k), count:byRole[k] }; }), C.teal);
  featBar('visa-by-sector', Object.keys(bySector).map(function(k){ return { name:k, count:bySector[k] }; }), C.gold);

  var ex=document.getElementById('visa-examples');
  if(!examples.length) ex.innerHTML='<p style="padding:12px;color:#7A9C9C;font-size:11px">No visa-language matches in the current filter — nothing to audit.</p>';
  else {
    var h='<table class="data-tbl"><thead><tr><th>Job Title</th><th>Company</th><th>Matched term</th><th>Snippet</th></tr></thead><tbody>';
    examples.forEach(function(e){ h+='<tr><td><b>'+esc(e.title)+'</b></td><td>'+esc(e.company)+'</td>'+
      '<td><span class="badge" style="background:#D4940A">'+esc(e.hit)+'</span></td>'+
      '<td class="desc-cell" style="max-width:420px">'+esc(e.snippet)+'</td></tr>'; });
    ex.innerHTML=h+'</tbody></table>';
  }

  document.getElementById('visa-method').innerHTML=
    '<b>Method &amp; caveats.</b> This scans each posting\'s Description, Requirements and Benefits (plus any explicit visa column) for visa/work-permit keywords in English and German (e.g. visa sponsorship, work permit, Arbeitserlaubnis, Aufenthaltstitel, Blue Card, §18). It is a keyword signal, not a legal determination — false positives (a passing mention) and false negatives (sponsorship offered but unstated) both occur, so the audit table is provided for spot-checking. To run the requested <b>100-role test batch</b>, load a CSV of those roles as any sector and read the KPIs above; a fresh live scrape of new roles is a separate collection step outside this dashboard, but this proves the metric is extractable from the scraped text you already have.';

  renderSourcesEval();
}
function featBar(id, arr, col){
  var s=arr.filter(function(d){return d.count>0;}).sort(function(a,b){return a.count-b.count;});
  if(!s.length){ Plotly.react(id,[],Object.assign({},base)); return; }
  Plotly.react(id,[{type:'bar',orientation:'h',
    y:s.map(function(d){return shortName(d.name);}), x:s.map(function(d){return d.count;}),
    marker:{color:col,line:{width:0}}, text:s.map(function(d){return fmt(d.count);}),
    textposition:'outside',textfont:{size:10,color:C.textM},cliponaxis:false,
    hovertemplate:'<b>%{y}</b><br>%{x:,d} postings<extra></extra>'}],
    Object.assign({},base,{xaxis:{showgrid:true,gridcolor:C.border,zeroline:false,showticklabels:false,fixedrange:true},
      yaxis:{showgrid:false,automargin:true,tickfont:{size:9},fixedrange:true},
      bargap:0.3,margin:{l:8,r:44,t:8,b:8}}),pc);
}
function snip(text, kw){
  if(!kw) return '';
  var t=String(text||''), i=t.toLowerCase().indexOf(kw);
  if(i<0) return t.slice(0,120);
  var a=Math.max(0,i-45), b=Math.min(t.length,i+kw.length+55);
  return (a>0?'…':'')+t.slice(a,b).replace(/\s+/g,' ').trim()+(b<t.length?'…':'');
}

var _sourcesRendered=false;
function renderSourcesEval(){
  if(_sourcesRendered) return; _sourcesRendered=true;
  var el=document.getElementById('sources-eval'); if(!el) return;
  el.innerHTML=
    '<div class="insight-box"><b>Bottom line:</b> BA and KOFA are current and granular enough for <b>occupation- and Land-level</b> decisions, and are the authoritative measure of the supply–demand gap (vacancy duration, unemployed-per-vacancy). They are <b>not</b> granular to employer or posting level, use the German <b>KldB 2010</b> classification (a crosswalk to this dashboard\'s ISCO-08 is required), and count only <b>vacancies reported to the BA</b>. They complement — they don\'t replace — the live StepStone employer-level signal shown here.</div>'+
    '<table class="data-tbl" style="margin-bottom:12px"><thead><tr>'+
      '<th>Dimension</th><th>BA · Fachkräfteengpassanalyse</th><th>KOFA · IW-Fachkräftedatenbank</th><th>Fit for this dashboard</th></tr></thead><tbody>'+
      row3('Update cadence','Annual analysis (2024 ed. published mid-2025; 2025 due ~June 2026), plus a monthly Fachkräftebedarf report','Monthly Fachkräftereport (e.g. March-2026 report published 1 Jul 2026), ~3-month lag','KOFA is fresher month-to-month; BA is the annual authority')+
      row3('Timeline depth','Multi-year time series per occupation in the interactive statistic','Monthly series + annual projection (Arbeitsmarktfortschreibung) to +3 yrs','Both adequate for trend detection')+
      row3('Occupational granularity','~1,200 occupations; national at 4-digit KldB, Länder at 3-digit, split by skill level','~1,300 KldB occupational categories; recent extension to economic sector (WZ-2 digit)','Deep enough; needs KldB→ISCO-08 crosswalk')+
      row3('Regional granularity','Germany + 16 Länder (full analysis); some indicators to Agentur-district','Down to Arbeitsagenturbezirk / urban-rural type','Länder matches this dashboard\'s map; sub-Land is a bonus')+
      row3('Coverage / basis','Registered vacancies + unemployment (6 shortage indicators)','Reported vacancies (report rate ~40–60% for skilled) + IAB/BIBB/Destatis','Undercounts unreported vacancies — a shared limitation')+
      row3('Employer / posting level','No','No','Only the StepStone scrape here reaches employer & text (e.g. visa) level')+
    '</tbody></table>'+
    '<div class="meth-body"><b>Recommendation.</b> Use BA/KOFA as the authoritative macro layer (which occupations are Engpassberufe, how long vacancies stay open, the size of the gap) and use this dashboard for the micro layer BA/KOFA cannot see: named employers, region-by-role detail, contract mix, and text-mined signals like visa sponsorship. Confirm each release\'s exact date before citing, and build a one-time KldB-2010 ↔ ISCO-08 crosswalk so the two layers line up. '+
    'Sources: BA Statistik (arbeitsagentur.de), IW Köln / KOFA (iwkoeln.de, kofa.de).</div>';
}
function row3(dim,a,b,fit){
  return '<tr><td><b>'+esc(dim)+'</b></td><td>'+esc(a)+'</td><td>'+esc(b)+'</td><td style="color:#1A7B7A">'+esc(fit)+'</td></tr>';
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
