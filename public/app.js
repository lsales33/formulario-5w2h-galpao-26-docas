(() => {
const $ = s => document.querySelector(s);
const nf1 = new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1,minimumFractionDigits:1});
const nf = new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2});
const brl = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Medidas típicas de mercado; o usuário pode ajustar
const VEH = {
  van:     {name:'Van',      h:2.7, l:6.0,  t:3.5, axles:2, cons:9.0},
  toco:    {name:'Toco',     h:3.8, l:10.0, t:16,  axles:2, cons:5.0},
  truck:   {name:'Caminhão', h:4.2, l:14.0, t:23,  axles:3, cons:3.8},
  carreta: {name:'Carreta',  h:4.4, l:18.6, t:45,  axles:5, cons:2.5}
};
const KEYS = ['h','l','t','axles'];

const state = { a:null, b:null, veh:'toco', specs:{}, tolls:false, price:'6.20', routes:[], sel:0, info:null, recents:[] };
Object.keys(VEH).forEach(v => state.specs[v] = {...VEH[v]});
const EXAMPLE = {
  a:{lat:-23.5614,lng:-46.6559,title:'Av. Paulista, 1578',sub:'Bela Vista · São Paulo/SP',label:'Av. Paulista, 1578 – São Paulo/SP',kind:'rua',example:true},
  b:{lat:-22.9056,lng:-47.0608,title:'Centro',sub:'Campinas/SP',label:'Centro – Campinas/SP',kind:'cidade',example:true}
};

// ---------- API ----------
async function api(path, params, ms=25000){
  const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), ms);
  try{
    const r = await fetch(path+'?'+new URLSearchParams(params), {signal:ctl.signal});
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ const e = new Error(j.error || 'Falha na consulta ('+r.status+')'); e.status=r.status; throw e; }
    return j;
  }catch(e){
    if(e.name==='AbortError') throw new Error('O servidor demorou a responder. Se ele estava parado, a primeira consulta leva até 1 minuto.');
    throw e;
  }finally{ clearTimeout(t); }
}
const isCEP = v => /^\s*\d{5}-?\d{3}\s*$/.test(v);
const looksCEP = v => /^\s*\d{2,5}-?\d{0,3}\s*$/.test(v);
const reverse = (lat,lng) => api('/api/reverse',{lat,lng},15000).then(j=>j.label).catch(()=>`${lat.toFixed(5)}, ${lng.toFixed(5)}`);

// ---------- ícones ----------
const I = {
  rua:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  cidade:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 21h18M5 21V9l5-3v15M10 21V4l9 4v13M13 10h3M13 14h3M7 12h1M7 16h1"/></svg>',
  local:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/></svg>',
  cep:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h4M7 14h7"/></svg>',
  gps:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  map:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
  hist:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>'
};
const KIND_TXT = {rua:'Endereço',cidade:'Cidade/bairro',local:'Local',cep:'CEP',mapa:'Ponto no mapa',gps:'Minha localização'};

// ---------- mapa ----------
const map = L.map('map',{zoomControl:true}).setView([-23.2,-46.9],9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const pinIcon = k => L.divIcon({className:'',html:`<div class="pin ${k}"><span>${k.toUpperCase()}</span></div>`,iconSize:[28,28],iconAnchor:[14,30]});
const markers = {a:null,b:null};
let lines = [];
const tipHtml = (k,p) => `<span class="k">${k==='a'?'Origem':'Destino'}</span><b>${esc(p.title||p.label)}</b>${p.sub?`<small>${esc(p.sub)}</small>`:''}<small>Arraste para ajustar</small>`;

function placeFromLabel(label, lat, lng, kind='mapa'){
  const parts = String(label).split(/ – |, /);
  return {lat,lng,label,title:parts[0],sub:parts.slice(1).join(' · '),kind};
}

function setPoint(k, p, {route=true, fit=true, remember=true}={}){
  state[k] = p;
  $('#in-'+k).value = p ? (p.title && p.kind==='cep' ? p.label : p.label) : '';
  renderMeta(k);
  if (markers[k]) { map.removeLayer(markers[k]); markers[k]=null; }
  if (p){
    markers[k] = L.marker([p.lat,p.lng],{icon:pinIcon(k),draggable:true,keyboard:true,title:k==='a'?'Origem':'Destino',riseOnHover:true}).addTo(map);
    markers[k].bindTooltip(tipHtml(k,p),{className:'addr',direction:'top',offset:[0,-28],opacity:1});
    markers[k].on('dragstart',()=>markers[k].closeTooltip());
    markers[k].on('dragend', async e => {
      const ll = e.target.getLatLng();
      setStatus('Buscando endereço do ponto…');
      const label = await reverse(ll.lat, ll.lng); setStatus('');
      setPoint(k, placeFromLabel(label, ll.lat, ll.lng), {fit:false, remember:false});
    });
    if (remember && !p.example && p.kind!=='gps') addRecent(p);
  }
  save();
  if (route && state.a && state.b) calcRoute(fit);
  else { clearRoute(); if (p && fit) map.setView([p.lat,p.lng],14); }
}
function renderMeta(k){
  const p = state[k], el = $('#meta-'+k);
  if(!p){ el.innerHTML=''; return; }
  const approx = p.kind==='cidade' || p.precision==='aproximada';
  let chips = p.kind==='cep' ? `<span class="chip ok">CEP ${esc(p.cep||'')}</span>` : `<span class="chip">${esc(KIND_TXT[p.kind]||'Endereço')}</span>`;
  if (approx) chips += '<span class="chip approx" title="O ponto fica no centro da região, não no número exato">aproximado</span>';
  if (p.example) chips += '<span class="chip">exemplo</span>';
  const sub = p.kind==='cep' ? String(p.sub||'').replace(/^CEP [\d-]+ · /,'') : (p.sub||'');
  el.innerHTML = chips + `<span>${esc(sub)}</span>`;
  el.title = p.sub || '';
}

// escolher ponto no mapa
let pickTarget = null, pickbar = null;
function startPick(k){
  stopPick();
  pickTarget = k;
  $('#map').classList.add('picking');
  pickbar = document.createElement('div'); pickbar.className='pickbar';
  pickbar.innerHTML = `<span>Clique no mapa para definir ${k==='a'?'a origem':'o destino'}</span><button type="button">Cancelar</button>`;
  pickbar.querySelector('button').onclick = stopPick;
  L.DomEvent.disableClickPropagation(pickbar);
  $('#map').append(pickbar);
  if (matchMedia('(max-width:760px)').matches) window.scrollTo({top:0,behavior:'smooth'});
}
function stopPick(){ pickTarget=null; $('#map').classList.remove('picking'); pickbar && pickbar.remove(); pickbar=null; }
document.addEventListener('keydown', e => { if(e.key==='Escape' && pickTarget) stopPick(); });

map.on('click', async e => {
  const {lat,lng} = e.latlng;
  if (pickTarget){
    const k = pickTarget; stopPick();
    setStatus('Buscando endereço do ponto…');
    const label = await reverse(lat,lng); setStatus('');
    setPoint(k, placeFromLabel(label,lat,lng), {fit:false, remember:false});
    return;
  }
  const pop = L.popup().setLatLng(e.latlng).setContent(`<div class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div><div class="popbtns"><button data-k="a">Definir origem</button><button data-k="b">Definir destino</button></div>`).openOn(map);
  pop.getElement().querySelectorAll('button').forEach(b => b.onclick = async () => {
    map.closePopup();
    setStatus('Buscando endereço do ponto…');
    const label = await reverse(lat,lng); setStatus('');
    setPoint(b.dataset.k, placeFromLabel(label,lat,lng), {fit:false, remember:false});
  });
});

// ---------- recentes ----------
function addRecent(p){
  const key = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  state.recents = [p, ...state.recents.filter(r => `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`!==key)].slice(0,6);
}

// ---------- autocompletar ----------
const fold = c => c.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
function highlight(text, q){
  const chars = [...String(text)], norm = chars.map(fold).join('');
  const mask = new Array(chars.length).fill(false);
  fold(q).split(/[\s,]+/).filter(w=>w.length>=2).forEach(w => {
    let i = norm.indexOf(w);
    while(i>=0){ for(let j=i;j<i+w.length;j++) mask[j]=true; i = norm.indexOf(w,i+w.length); }
  });
  let out='', open=false;
  chars.forEach((c,i)=>{ if(mask[i]&&!open){out+='<mark>';open=true;} if(!mask[i]&&open){out+='</mark>';open=false;} out+=esc(c); });
  return out + (open?'</mark>':'');
}

function autocomplete(k){
  const input = $('#in-'+k), field = input.parentElement;
  let list=null, opts=[], idx=-1, timer=null, seq=0, lastQ='';
  const isOpen = () => !!list;
  const close = () => { list && list.remove(); list=null; opts=[]; idx=-1; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); };
  function draw(html, items, sel=-1){
    if(!list){ list=document.createElement('ul'); list.className='sugg'; list.id='sugg-'+k; list.setAttribute('role','listbox'); field.append(list);
      list.addEventListener('mousedown', e => e.preventDefault()); }
    list.innerHTML = html; opts = items; idx = sel;
    list.querySelectorAll('.opt').forEach((li,i)=>{ li.id=`opt-${k}-${i}`; li.onclick=()=>choose(i); li.onmousemove=()=>{ if(idx!==i){ idx=i; mark(); } }; });
    input.setAttribute('aria-expanded','true'); mark();
  }
  const mark = () => {
    if(!list) return;
    list.querySelectorAll('.opt').forEach((li,i)=>li.setAttribute('aria-selected', i===idx));
    const cur = list.querySelector(`#opt-${k}-${idx}`);
    if(cur){ input.setAttribute('aria-activedescendant',cur.id); cur.scrollIntoView({block:'nearest'}); } else input.removeAttribute('aria-activedescendant');
  };
  const optHtml = (icon, title, sub, extra='') => `<li class="opt" role="option"><span class="ico">${icon}</span><span class="txt"><span class="t">${title}</span>${sub?`<span class="s">${sub}</span>`:''}</span>${extra}</li>`;
  const keysHtml = '<li class="keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> escolher</span><span><kbd>Esc</kbd> fechar</span></li>';

  function showBase(){
    const items=[]; let html='';
    if ('geolocation' in navigator){ html+=optHtml(I.gps,'Usar minha localização','Pelo GPS do aparelho'); items.push({act:'gps'}); }
    html+=optHtml(I.map,'Escolher no mapa','Clique no ponto exato'); items.push({act:'map'});
    const rec = state.recents.filter(r => !state[k] || r.label!==state[k].label).slice(0,5);
    if (rec.length){
      html+='<li class="grp" role="presentation">Recentes</li>';
      rec.forEach(r=>{ html+=optHtml(I.hist, esc(r.title||r.label), esc(r.sub||'')); items.push({place:r}); });
    }
    draw(html+keysHtml, items, -1);
  }
  function showLoading(q){
    draw(`<li class="grp" role="presentation">${looksCEP(q)?'Consultando CEP':'Buscando endereços'}</li><li class="skel" aria-hidden="true"></li><li class="skel" aria-hidden="true"></li><li class="skel" aria-hidden="true"></li>`, [], -1);
  }
  function showResults(q, res){
    if(!res.length){ draw(`<li class="msg">Nenhum endereço encontrado para “${esc(q)}”.<br>Inclua a cidade (ex.: “Rua X, Campinas”) ou use o CEP.</li>`,[],-1); return; }
    let html=`<li class="grp" role="presentation">${res[0].kind==='cep'?'CEP encontrado':'Sugestões'}</li>`;
    res.forEach(r=>{
      const approx = r.kind==='cidade' || r.precision==='aproximada' ? '<span class="chip approx">aprox.</span>' : '';
      html+=optHtml(I[r.kind]||I.rua, highlight(r.title,q), esc(r.sub||''), approx);
    });
    draw(html+keysHtml, res.map(r=>({place:r})), 0);
  }
  function showMsg(msg, err){ draw(`<li class="msg${err?' err':''}">${esc(msg)}</li>`,[],-1); }

  async function search(){
    const q = input.value.trim(); const my = ++seq; lastQ=q;
    if (!q || (state[k] && q===state[k].label)) { showBase(); return; }
    if (looksCEP(q) && !isCEP(q)) { showMsg('Continue digitando o CEP (8 dígitos).'); return; }
    if (q.length<3){ showBase(); return; }
    showLoading(q);
    try{
      const c = map.getCenter();
      const res = isCEP(q) ? await api('/api/cep',{cep:q.replace(/\D/g,'')}) : await api('/api/geocode',{q,near:`${c.lat.toFixed(3)},${c.lng.toFixed(3)}`});
      if (my!==seq) return;
      showResults(q,res);
    }catch(e){ if(my===seq) showMsg(e.status===404 && isCEP(q) ? 'CEP não encontrado. Confira os números.' : e.message, true); }
  }
  async function choose(i){
    const o = opts[i]; if(!o) return;
    close();
    if (o.act==='map'){ input.blur(); startPick(k); return; }
    if (o.act==='gps'){
      setStatus('Obtendo sua localização…');
      navigator.geolocation.getCurrentPosition(async pos => {
        const {latitude:lat, longitude:lng} = pos.coords;
        const label = await reverse(lat,lng); setStatus('');
        setPoint(k, {...placeFromLabel(label,lat,lng,'gps')});
      }, err => setStatus(err.code===1 ? 'Permissão de localização negada no navegador.' : 'Não foi possível obter sua localização.', true), {enableHighAccuracy:true, timeout:12000});
      return;
    }
    setPoint(k, o.place);
    const other = k==='a' ? 'b' : 'a';
    if (!state[other]) $('#in-'+other).focus();
  }

  input.addEventListener('input', () => { clearTimeout(timer); const v=input.value; timer=setTimeout(search, isCEP(v)?60:300); if(v.trim().length>=3 && !looksCEP(v)) showLoading(v.trim()); });
  input.addEventListener('focus', () => { input.select(); showBase(); });
  input.addEventListener('blur', () => setTimeout(()=>{ close(); if(state[k] && input.value!==state[k].label) input.value = state[k].label; }, 120));
  input.addEventListener('keydown', async e => {
    const n = opts.length;
    if (e.key==='ArrowDown'){ e.preventDefault(); if(!isOpen()) showBase(); else if(n){ idx=(idx+1)%n; mark(); } }
    else if (e.key==='ArrowUp'){ e.preventDefault(); if(n){ idx=(idx-1+n)%n; mark(); } }
    else if (e.key==='Enter'){
      e.preventDefault();
      if (idx>=0) return choose(idx);
      clearTimeout(timer); await search(); if (opts.length && opts[0].place) choose(0);
    }
    else if (e.key==='Tab' && isOpen() && idx>=0 && input.value.trim()!==(state[k]&&state[k].label)){ choose(idx); }
    else if (e.key==='Escape'){ if(isOpen()){ e.stopPropagation(); close(); } }
  });
}
autocomplete('a'); autocomplete('b');

document.querySelectorAll('.clear').forEach(b => b.onclick = () => { const k=b.dataset.k; setPoint(k,null,{route:false,fit:false}); clearRoute(); $('#in-'+k).focus(); });
$('#swap').onclick = () => { const a=state.a, b=state.b; setPoint('a',b,{route:false,remember:false}); setPoint('b',a,{remember:false}); };

// ---------- veículo ----------
const spec = () => state.specs[state.veh];
const isDefault = v => KEYS.every(key => +state.specs[v][key] === +VEH[v][key]);
function renderVehicle(){
  document.querySelectorAll('.veh').forEach(b => { const on = b.dataset.v===state.veh; b.setAttribute('aria-checked', on); b.tabIndex = on?0:-1; });
  const s = spec();
  $('#specline').textContent = `Altura ${nf.format(s.h)} m · Compr. ${nf.format(s.l)} m · PBT ${nf.format(s.t)} t · ${s.axles} eixos${isDefault(state.veh)?'':' (ajustado)'}`;
  $('#s-h').value=s.h; $('#s-l').value=s.l; $('#s-t').value=s.t; $('#s-ax').value=s.axles;
  $('#c-cons').value = s.cons;
  $('#tolls').checked = state.tolls;
}
function selectVehicle(v){ state.veh=v; renderVehicle(); save(); recalc(); }
document.querySelectorAll('.veh').forEach(b => {
  b.onclick = () => selectVehicle(b.dataset.v);
  b.onkeydown = e => {
    const ids = Object.keys(VEH), i = ids.indexOf(state.veh);
    const d = {ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];
    if (d){ e.preventDefault(); const nv = ids[(i+d+ids.length)%ids.length]; selectVehicle(nv); document.querySelector(`.veh[data-v="${nv}"]`).focus(); }
  };
});
$('#spec-toggle').onclick = () => { const open = $('#specs').hidden; $('#specs').hidden = !open; $('#spec-toggle').setAttribute('aria-expanded', open); $('#spec-toggle').textContent = open ? 'Fechar medidas' : 'Ajustar medidas'; };
[['#s-h','h'],['#s-l','l'],['#s-t','t'],['#s-ax','axles']].forEach(([sel,key]) => $(sel).addEventListener('change', () => {
  const el=$(sel), n=parseFloat(el.value);
  if(!Number.isFinite(n)){ renderVehicle(); return; }
  const v = Math.min(Math.max(n, +el.min), +el.max);
  spec()[key] = key==='axles' ? Math.round(v) : v;
  renderVehicle(); save(); recalc();
}));
$('#spec-reset').onclick = () => { const c = spec().cons; state.specs[state.veh] = {...VEH[state.veh], cons:c}; renderVehicle(); save(); recalc(); };
$('#tolls').onchange = () => { state.tolls = $('#tolls').checked; save(); recalc(); };
let recalcT; function recalc(){ clearTimeout(recalcT); recalcT = setTimeout(()=>{ if(state.a&&state.b) calcRoute(false); }, 250); }

// ---------- rota ----------
function setStatus(msg, err=false){ const s=$('#status'); s.textContent=msg; s.classList.toggle('err',err); }
function clearRoute(){
  lines.forEach(l=>map.removeLayer(l)); lines=[]; state.routes=[];
  ['#result','#alts-wrap','#cost-wrap','#act-wrap','#steps-wrap'].forEach(s=>$(s).hidden=true);
}
let routeSeq=0;
async function calcRoute(fit){
  const my=++routeSeq, s=spec();
  setStatus(`Calculando rota para ${VEH[state.veh].name.toLowerCase()}…`);
  try{
    const j = await api('/api/route',{from:`${state.a.lat},${state.a.lng}`,to:`${state.b.lat},${state.b.lng}`,vehicle:state.veh,h:s.h,l:s.l,t:s.t,axles:s.axles,tolls:state.tolls?'avoid':'allow'},60000);
    if (my!==routeSeq) return;
    setStatus('');
    state.routes=j.routes; state.sel=0; state.info={provider:j.provider,truckRules:j.truckRules,tollsAvoided:j.tollsAvoided,veh:state.veh,spec:{...s},tolls:state.tolls};
    drawRoutes(fit); renderAll();
  }catch(e){
    if (my!==routeSeq) return;
    clearRoute(); setStatus(e.message, true);
  }
}
function drawRoutes(fit){
  lines.forEach(l=>map.removeLayer(l)); lines=[];
  const alt = getComputedStyle(document.documentElement).getPropertyValue('--alt').trim();
  state.routes.forEach((r,i)=>{
    if(i===state.sel) return;
    const l = L.polyline(r.coords,{color:alt,weight:5,opacity:.75,dashArray:'6 8'}).addTo(map);
    l.on('click',()=>selectRoute(i)); l.bindTooltip(`Alternativa: ${fmtKm(r.distance)} · ${fmtDur(r.duration)}`,{sticky:true,className:'addr'});
    lines.push(l);
  });
  const r = state.routes[state.sel];
  lines.push(L.polyline(r.coords,{color:'#ffffff',weight:9,opacity:.9}).addTo(map));
  const top = L.polyline(r.coords,{color:'#0b6b3a',weight:5.5}).addTo(map); lines.push(top);
  Object.values(markers).forEach(m=>m&&m.setZIndexOffset(1000));
  if (fit) map.fitBounds(top.getBounds(),{padding:[40,40]});
}
function selectRoute(i){ state.sel=i; drawRoutes(false); renderAll(); }

const fmtKm = m => m<1000 ? Math.round(m)+' m' : nf1.format(m/1000)+' km';
function fmtDur(s){ const m=Math.round(s/60); if(m<60) return m+' min'; const h=Math.floor(m/60), r=m%60; return h+' h'+(r? ' '+String(r).padStart(2,'0')+' min':''); }
const viaTxt = r => r.summary ? 'via '+r.summary : '';

function renderAll(){
  const r = state.routes[state.sel], km = r.distance/1000, info = state.info, s = info.spec;
  $('#result').hidden=false;
  $('#r-veh').textContent = VEH[info.veh].name;
  $('#r-dest').textContent = state.b.title || state.b.label;
  $('#r-km').innerHTML = km<1 ? Math.round(r.distance)+'<small>m</small>' : nf1.format(km)+'<small>km</small>';
  $('#r-time').textContent = fmtDur(r.duration);
  const eta = new Date(Date.now()+r.duration*1000);
  $('#r-eta').textContent = 'chegada ≈ '+eta.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+(eta.toDateString()!==new Date().toDateString()?' (outro dia)':'');
  $('#r-via').textContent = viaTxt(r);

  const n = $('#r-notice');
  let txt;
  if (info.truckRules){
    n.className='notice ok';
    txt = `Rota de caminhão: considera altura ${nf.format(s.h)} m, comprimento ${nf.format(s.l)} m e ${nf.format(s.t)} t.`;
  } else {
    n.className='notice warn';
    txt = `Rota feita em vias para carro, com tempo ajustado para ${VEH[info.veh].name.toLowerCase()}. Ela não verifica limites de altura e peso nem zonas de restrição a caminhões (ex.: ZMRC em São Paulo).`;
  }
  if (info.tolls) txt += info.tollsAvoided ? ' Sem pedágios.' : ' Não foi possível evitar pedágios nesta rota.';
  n.textContent = txt;

  const alts=$('#alts'); alts.innerHTML='';
  $('#alts-wrap').hidden = state.routes.length<2;
  state.routes.forEach((x,i)=>{
    const b=document.createElement('button'); b.setAttribute('aria-pressed', i===state.sel);
    const sm=x.summary||'Rota '+(i+1);
    b.innerHTML=`<b>${fmtDur(x.duration)}</b><small>${fmtKm(x.distance)}</small><small></small>`;
    b.lastChild.textContent = sm; b.title=sm;
    b.onclick=()=>selectRoute(i); alts.append(b);
  });

  $('#cost-wrap').hidden = false;
  updateCost();

  const g = new URL('https://www.google.com/maps/dir/');
  g.searchParams.set('api','1'); g.searchParams.set('origin',`${state.a.lat},${state.a.lng}`);
  g.searchParams.set('destination',`${state.b.lat},${state.b.lng}`); g.searchParams.set('travelmode','driving');
  $('#gmaps').href=g.toString(); $('#act-wrap').hidden=false;

  renderSteps(r);
}
function updateCost(){
  const r=state.routes[state.sel]; if(!r) return;
  const cons=parseFloat($('#c-cons').value), price=parseFloat($('#c-price').value);
  const out=$('#c-out');
  if(!(cons>0)||!(price>=0)){ out.textContent='Informe consumo e preço do diesel.'; return; }
  const l=r.distance/1000/cons;
  out.innerHTML=`${brl.format(l*price)} <span>só ida · ${nf1.format(l)} l · ida e volta ${brl.format(2*l*price)}</span>`;
}
$('#c-cons').addEventListener('input',()=>{ const n=parseFloat($('#c-cons').value); if(n>0) spec().cons=n; updateCost(); save(); });
$('#c-price').addEventListener('input',()=>{ state.price=$('#c-price').value; updateCost(); save(); });

function icon(s){
  if(s.kind==='depart') return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>';
  if(s.kind==='arrive') return '<svg viewBox="0 0 24 24"><path d="M6 21V4h11l-2 4 2 4H8v9z" fill="currentColor"/></svg>';
  if(s.kind==='roundabout') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="13" r="5"/><path d="M12 3v5M9 5l3-3 3 3"/></svg>';
  if(s.kind==='uturn') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M16 21V9a5 5 0 0 0-10 0v4M3 10l3 3 3-3"/></svg>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${+s.angle||0}deg)"><path d="M12 21V4M6 10l6-6 6 6"/></svg>`;
}
function renderSteps(r){
  const ol=$('#steps'); ol.innerHTML='';
  r.steps.forEach(s=>{
    const li=document.createElement('li'); li.tabIndex=0;
    li.innerHTML = `${icon(s)}<div><span class="t"></span><span class="n"></span></div><span class="d">${s.distance>0?fmtKm(s.distance):''}</span>`;
    li.querySelector('.t').textContent = s.text;
    li.querySelector('.n').textContent = s.name;
    const go=()=>{ map.setView(s.loc,16); if(matchMedia('(max-width:760px)').matches) window.scrollTo({top:0,behavior:'smooth'}); };
    li.onclick=go; li.onkeydown=e=>{ if(e.key==='Enter') go(); };
    ol.append(li);
  });
  $('#steps-wrap').hidden=false;
}

$('#copy').onclick = async () => {
  const r=state.routes[state.sel]; if(!r) return;
  const s=state.info.spec;
  const txt = `Rota (${VEH[state.info.veh].name} · ${nf.format(s.h)} m · ${nf.format(s.t)} t · ${s.axles} eixos)\n${state.a.label} → ${state.b.label}\nDistância: ${fmtKm(r.distance)} · Tempo: ${fmtDur(r.duration)}${r.summary?'\n'+viaTxt(r):''}\nDiesel: ${$('#c-out').textContent}\nMapa: ${$('#gmaps').href}`;
  try{ await navigator.clipboard.writeText(txt); setStatus('Resumo copiado.'); }
  catch(e){ const t=document.createElement('textarea'); t.value=txt; document.body.append(t); t.select(); try{document.execCommand('copy'); setStatus('Resumo copiado.');}catch(_){setStatus('Não foi possível copiar.',true);} t.remove(); }
  setTimeout(()=>{ if($('#status').textContent==='Resumo copiado.') setStatus(''); }, 2500);
};

// ---------- persistência local ----------
const STORE='roteirizador-v2';
function save(){ try{ localStorage.setItem(STORE, JSON.stringify({a:state.a,b:state.b,veh:state.veh,specs:state.specs,tolls:state.tolls,price:state.price,recents:state.recents})); }catch(e){} }
let saved=null; try{ saved=JSON.parse(localStorage.getItem(STORE)||'null'); }catch(e){}
if (saved){
  if (VEH[saved.veh]) state.veh=saved.veh;
  if (saved.specs) Object.keys(VEH).forEach(v => { if(saved.specs[v]) state.specs[v] = {...VEH[v], ...saved.specs[v]}; });
  state.tolls=!!saved.tolls; if(saved.price) state.price=saved.price;
  if (Array.isArray(saved.recents)) state.recents=saved.recents.filter(r=>r&&Number.isFinite(r.lat)).slice(0,6);
}
$('#c-price').value = state.price;
renderVehicle();
const start = saved && saved.a && saved.b ? saved : EXAMPLE;
setPoint('a', start.a, {route:false, fit:false, remember:false});
setPoint('b', start.b, {remember:false});
})();
