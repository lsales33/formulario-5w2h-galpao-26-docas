(() => {
const $ = s => document.querySelector(s);
const nf1 = new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1,minimumFractionDigits:1});
const brl = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const MODES = ['car','bike','foot'];
const GM_MODE = {car:'driving',bike:'bicycling',foot:'walking'};
const PROVIDER_TXT = {
  osm:'Rotas: OSRM/OpenStreetMap · Busca: Photon/Nominatim · Tempo sem trânsito em tempo real',
  google:'Rotas e busca: Google Maps Platform · Tempo de carro considera o trânsito'
};

const state = { a:null, b:null, mode:'car', routes:[], sel:0, provider:'osm', traffic:false };
const EXAMPLE = {
  a:{lat:-23.5614,lng:-46.6559,label:'Av. Paulista, 1578 – São Paulo/SP (exemplo)'},
  b:{lat:-22.9056,lng:-47.0608,label:'Centro – Campinas/SP (exemplo)'}
};

// ---------- API própria ----------
async function api(path, params, ms=25000){
  const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), ms);
  try{
    const r = await fetch(path+'?'+new URLSearchParams(params), {signal:ctl.signal});
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ const e = new Error(j.error || 'Falha na consulta ('+r.status+')'); e.status=r.status; throw e; }
    return j;
  }catch(e){
    if(e.name==='AbortError') throw new Error('O servidor demorou a responder. Se o serviço estava parado, a primeira consulta leva até 1 minuto.');
    throw e;
  }finally{ clearTimeout(t); }
}
const isCEP = v => /^\s*\d{5}-?\d{3}\s*$/.test(v);
const geocode = q => { const c = map.getCenter(); return api('/api/geocode',{q,near:`${c.lat.toFixed(3)},${c.lng.toFixed(3)}`}); };
const byCEP = v => api('/api/cep',{cep:v.replace(/\D/g,'')});
const reverse = (lat,lng) => api('/api/reverse',{lat,lng},12000).then(j=>j.label).catch(()=>`${lat.toFixed(5)}, ${lng.toFixed(5)}`);

// ---------- mapa ----------
const map = L.map('map',{zoomControl:true}).setView([-23.2,-46.9],9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const pinIcon = k => L.divIcon({className:'',html:`<div class="pin ${k}"><span>${k.toUpperCase()}</span></div>`,iconSize:[28,28],iconAnchor:[14,30]});
const markers = {a:null,b:null};
let lines = [];

function setPoint(k, p, {route=true, fit=true}={}){
  state[k] = p;
  $('#in-'+k).value = p ? p.label : '';
  if (markers[k]) { map.removeLayer(markers[k]); markers[k]=null; }
  if (p){
    markers[k] = L.marker([p.lat,p.lng],{icon:pinIcon(k),draggable:true,keyboard:true,title:k==='a'?'Origem':'Destino'}).addTo(map);
    markers[k].on('dragend', async e => {
      const ll = e.target.getLatLng();
      const label = await reverse(ll.lat, ll.lng);
      setPoint(k,{lat:ll.lat,lng:ll.lng,label},{fit:false});
    });
  }
  save();
  if (route && state.a && state.b) calcRoute(fit);
  else { clearRoute(); if (p && fit) map.setView([p.lat,p.lng],14); }
}

map.on('click', e => {
  const {lat,lng} = e.latlng;
  const pop = L.popup().setLatLng(e.latlng).setContent(`<div class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div><div class="popbtns"><button data-k="a">Definir origem</button><button data-k="b">Definir destino</button></div>`).openOn(map);
  pop.getElement().querySelectorAll('button').forEach(b => b.onclick = async () => {
    map.closePopup();
    setStatus('Buscando endereço do ponto…');
    const label = await reverse(lat,lng);
    setStatus('');
    setPoint(b.dataset.k,{lat,lng,label},{fit:false});
  });
});

// ---------- autocompletar ----------
function autocomplete(k){
  const input = $('#in-'+k), field = input.parentElement;
  let list=null, items=[], idx=-1, timer=null, seq=0;
  const close = () => { list && list.remove(); list=null; items=[]; idx=-1; input.setAttribute('aria-expanded','false'); };
  const render = () => {
    list && list.remove(); list=null;
    if(!items.length){ input.setAttribute('aria-expanded','false'); return; }
    list = document.createElement('ul'); list.className='sugg'; list.setAttribute('role','listbox');
    items.forEach((it,i)=>{
      const li=document.createElement('li'); li.setAttribute('role','option');
      const b=document.createElement('b'); b.textContent=it.title; li.append(b);
      if(it.sub){const s=document.createElement('small'); s.textContent=it.sub+(it.precision==='aproximada'?' · posição aproximada':''); li.append(s);}
      li.onmousedown = e => { e.preventDefault(); pick(i); };
      list.append(li);
    });
    field.append(list); input.setAttribute('aria-expanded','true');
  };
  const highlight = () => list && [...list.children].forEach((li,i)=>li.setAttribute('aria-selected', i===idx));
  const pick = i => { const it=items[i]; if(!it) return; close(); setPoint(k,{lat:it.lat,lng:it.lng,label:it.label}); };
  const search = async () => {
    const q = input.value.trim(); const my = ++seq;
    if (q.length<3){ close(); return; }
    try{
      const res = isCEP(q) ? await byCEP(q) : await geocode(q);
      if (my!==seq) return;
      items=res; idx=-1; render();
      if(!res.length) setStatus('Nada encontrado para “'+q+'”. Tente incluir a cidade.', true); else setStatus('');
    }catch(e){ if(my===seq){ close(); setStatus(e.message, true);} }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer=setTimeout(search, isCEP(input.value)?50:380); });
  input.addEventListener('keydown', async e => {
    if(e.key==='ArrowDown'&&items.length){ idx=(idx+1)%items.length; highlight(); e.preventDefault(); }
    else if(e.key==='ArrowUp'&&items.length){ idx=(idx-1+items.length)%items.length; highlight(); e.preventDefault(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(items.length) pick(Math.max(idx,0)); else { clearTimeout(timer); await search(); if(items.length) pick(0);} }
    else if(e.key==='Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close,150));
  input.addEventListener('focus', () => input.select());
}
autocomplete('a'); autocomplete('b');

document.querySelectorAll('.clear').forEach(b => b.onclick = () => { setPoint(b.dataset.k,null,{route:false,fit:false}); clearRoute(); $('#in-'+b.dataset.k).focus(); });
$('#swap').onclick = () => { const a=state.a, b=state.b; setPoint('a',b,{route:false}); setPoint('b',a); };
document.querySelectorAll('.modes button').forEach(b => b.onclick = () => {
  state.mode=b.dataset.mode;
  document.querySelectorAll('.modes button').forEach(x=>x.setAttribute('aria-pressed', x===b));
  save(); if(state.a&&state.b) calcRoute(true);
});

// ---------- rota ----------
function setStatus(msg, err=false){ const s=$('#status'); s.textContent=msg; s.classList.toggle('err',err); }
function clearRoute(){
  lines.forEach(l=>map.removeLayer(l)); lines=[]; state.routes=[];
  ['#result','#alts-wrap','#cost-wrap','#act-wrap','#steps-wrap'].forEach(s=>$(s).hidden=true);
}
let routeSeq=0;
async function calcRoute(fit){
  const my=++routeSeq;
  setStatus('Calculando rota…');
  const {a,b,mode}=state;
  try{
    const j = await api('/api/route',{from:`${a.lat},${a.lng}`,to:`${b.lat},${b.lng}`,mode},60000);
    if (my!==routeSeq) return;
    setStatus('');
    state.routes=j.routes; state.sel=0; state.provider=j.provider; state.traffic=j.traffic;
    $('#foot').textContent = (PROVIDER_TXT[j.provider]||'') + ' · Mapa © colaboradores do OpenStreetMap · CEP: ViaCEP · Pedágios não incluídos.';
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
    l.on('click',()=>selectRoute(i)); l.bindTooltip(`${fmtKm(r.distance)} · ${fmtDur(r.duration)}`,{sticky:true});
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
const viaTxt = r => r.summary ? (r.summary.startsWith('via ') ? r.summary : 'via '+r.summary) : '';

function renderAll(){
  const r = state.routes[state.sel], km = r.distance/1000;
  $('#result').hidden=false;
  $('#r-dest').textContent = state.b.label.replace(/\s*\(exemplo\)/,'');
  $('#r-km').innerHTML = km<1 ? Math.round(r.distance)+'<small>m</small>' : nf1.format(km)+'<small>km</small>';
  $('#r-time').textContent = fmtDur(r.duration);
  const eta = new Date(Date.now()+r.duration*1000);
  $('#r-eta').textContent = 'chegada ≈ '+eta.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+(eta.toDateString()!==new Date().toDateString()?' (outro dia)':'')+(state.traffic?' · com trânsito':'');
  $('#r-via').textContent = viaTxt(r);

  const alts=$('#alts'); alts.innerHTML='';
  $('#alts-wrap').hidden = state.routes.length<2;
  state.routes.forEach((x,i)=>{
    const b=document.createElement('button'); b.setAttribute('aria-pressed', i===state.sel);
    const s=viaTxt(x).replace(/^via /,'')||'Rota '+(i+1);
    b.innerHTML=`<b>${fmtDur(x.duration)}</b><small>${fmtKm(x.distance)}</small><small></small>`;
    b.lastChild.textContent = s; b.title=s;
    b.onclick=()=>selectRoute(i); alts.append(b);
  });

  $('#cost-wrap').hidden = state.mode!=='car';
  updateCost();

  const g = new URL('https://www.google.com/maps/dir/');
  g.searchParams.set('api','1'); g.searchParams.set('origin',`${state.a.lat},${state.a.lng}`);
  g.searchParams.set('destination',`${state.b.lat},${state.b.lng}`); g.searchParams.set('travelmode',GM_MODE[state.mode]);
  $('#gmaps').href=g.toString(); $('#act-wrap').hidden=false;

  renderSteps(r);
}
function updateCost(){
  const r=state.routes[state.sel]; if(!r) return;
  const cons=parseFloat($('#c-cons').value), price=parseFloat($('#c-price').value);
  const out=$('#c-out');
  if(!(cons>0)||!(price>=0)){ out.textContent='Informe consumo e preço.'; return; }
  const l=r.distance/1000/cons;
  out.innerHTML=`${brl.format(l*price)} <span>só ida · ${nf1.format(l)} l · ida e volta ${brl.format(2*l*price)}</span>`;
}
['#c-cons','#c-price'].forEach(s=>$(s).addEventListener('input',()=>{updateCost();save();}));

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
  const modo={car:'carro',bike:'bicicleta',foot:'a pé'}[state.mode];
  const txt = `Rota (${modo}): ${state.a.label} → ${state.b.label}\nDistância: ${fmtKm(r.distance)} · Tempo: ${fmtDur(r.duration)}${r.summary?'\n'+viaTxt(r):''}\nMapa: ${$('#gmaps').href}`;
  try{ await navigator.clipboard.writeText(txt); setStatus('Resumo copiado.'); }
  catch(e){ const t=document.createElement('textarea'); t.value=txt; document.body.append(t); t.select(); try{document.execCommand('copy'); setStatus('Resumo copiado.');}catch(_){setStatus('Não foi possível copiar.',true);} t.remove(); }
};

// ---------- persistência local ----------
function save(){ try{ localStorage.setItem('roteirizador-ab', JSON.stringify({a:state.a,b:state.b,mode:state.mode,cons:$('#c-cons').value,price:$('#c-price').value})); }catch(e){} }
let saved=null; try{ saved=JSON.parse(localStorage.getItem('roteirizador-ab')||'null'); }catch(e){}
if (saved){
  if(saved.cons) $('#c-cons').value=saved.cons; if(saved.price) $('#c-price').value=saved.price;
  if(MODES.includes(saved.mode)){ state.mode=saved.mode; document.querySelectorAll('.modes button').forEach(x=>x.setAttribute('aria-pressed', x.dataset.mode===state.mode)); }
}
const start = saved && saved.a && saved.b ? saved : EXAMPLE;
setPoint('a', start.a, {route:false, fit:false});
setPoint('b', start.b);
})();
