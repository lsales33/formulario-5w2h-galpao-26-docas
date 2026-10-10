// Roteirizador A→B — servidor HTTP sem dependências (Node >= 18)
// Endereços: OSM por padrão, Google com GOOGLE_MAPS_API_KEY. Rotas de caminhão: OpenRouteService com ORS_API_KEY; sem chave, OSRM com tempo ajustado.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
const PROVIDER = GOOGLE_KEY ? 'google' : 'osm';
const UA = process.env.USER_AGENT || 'Roteirizador-AB/1.0 (+https://render.com)';
const RATE_PER_MIN = +process.env.RATE_PER_MIN || 90;
const PUBLIC = path.join(__dirname, 'public');

// ---------- utilitários ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = fn().then(v => v, e => { cache.delete(key); throw e; });
  cache.set(key, { exp: Date.now() + ttlMs, val });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return val;
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60_000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return arr.length > RATE_PER_MIN;
}

async function getJSON(url, opts = {}, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR', ...(opts.headers || {}) } });
    const body = await r.json().catch(() => null);
    if (!r.ok) { const e = new HttpError(502, `upstream ${r.status}`); e.body = body; throw e; }
    return body;
  } finally { clearTimeout(t); }
}

const UF = {'Acre':'AC','Alagoas':'AL','Amapá':'AP','Amazonas':'AM','Bahia':'BA','Ceará':'CE','Distrito Federal':'DF','Espírito Santo':'ES','Goiás':'GO','Maranhão':'MA','Mato Grosso':'MT','Mato Grosso do Sul':'MS','Minas Gerais':'MG','Pará':'PA','Paraíba':'PB','Paraná':'PR','Pernambuco':'PE','Piauí':'PI','Rio de Janeiro':'RJ','Rio Grande do Norte':'RN','Rio Grande do Sul':'RS','Rondônia':'RO','Roraima':'RR','Santa Catarina':'SC','São Paulo':'SP','Sergipe':'SE','Tocantins':'TO'};
const uf = s => UF[s] || s;
const num = (v, name) => { const n = parseFloat(v); if (!Number.isFinite(n)) throw new HttpError(400, `parâmetro inválido: ${name}`); return n; };
function parsePt(s, name) {
  const [lat, lng] = String(s || '').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, `ponto inválido: ${name} (use lat,lng)`);
  return { lat, lng };
}

// ---------- geocodificação: OSM ----------
function fmtPhoton(f) {
  const p = f.properties, [lng, lat] = f.geometry.coordinates;
  const street = p.street ? p.street + (p.housenumber ? ', ' + p.housenumber : '') : '';
  const title = p.name || street || p.city || 'Local';
  const sub = [p.name && street ? street : '', p.district || p.locality, p.city, p.state].filter((x, i, a) => x && a.indexOf(x) === i && x !== title).join(' · ');
  const label = [title, p.city && p.city !== title ? p.city : '', p.state ? uf(p.state) : ''].filter(Boolean).join(' – ');
  const kind = p.type === 'house' || p.type === 'street' ? 'rua' : ['city','locality','district','county','state'].includes(p.type) ? 'cidade' : 'local';
  return { lat, lng, title, sub, label, kind };
}
const osm = {
  async geocode(q, limit, bias) {
    try {
      const u = new URL('https://photon.komoot.io/api/');
      u.searchParams.set('q', q); u.searchParams.set('limit', limit);
      if (bias) { u.searchParams.set('lat', bias.lat.toFixed(3)); u.searchParams.set('lon', bias.lng.toFixed(3)); }
      const j = await getJSON(u);
      const out = (j.features || []).map(fmtPhoton);
      if (out.length) return out;
    } catch (_) { /* cai para o Nominatim */ }
    const u = new URL('https://nominatim.openstreetmap.org/search');
    Object.entries({ format: 'jsonv2', q, limit, addressdetails: 1, 'accept-language': 'pt-BR', countrycodes: 'br' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await getJSON(u);
    return j.map(r => { const parts = r.display_name.split(', '); return { lat: +r.lat, lng: +r.lon, title: parts.slice(0, 2).join(', '), sub: parts.slice(2, 5).join(' · '), label: parts.slice(0, 3).join(', '), kind: ['road','house','building'].includes(r.addresstype) ? 'rua' : ['city','town','village','suburb','municipality','state'].includes(r.addresstype) ? 'cidade' : 'local' }; });
  },
  async reverse(lat, lng) {
    try {
      const j = await getJSON(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}`, {}, 8000);
      if (j.features && j.features[0]) return fmtPhoton(j.features[0]).label;
    } catch (_) {}
    return null;
  }
};

// ---------- geocodificação: Google ----------
function fmtGoogle(r) {
  const c = k => (r.address_components.find(a => a.types.includes(k)) || {});
  const street = c('route').long_name ? c('route').long_name + (c('street_number').long_name ? ', ' + c('street_number').long_name : '') : '';
  const city = c('administrative_area_level_2').long_name || c('locality').long_name || '';
  const st = c('administrative_area_level_1').short_name || '';
  const parts = r.formatted_address.split(', ');
  const title = street || parts[0];
  const sub = [c('sublocality').long_name || c('sublocality_level_1').long_name, city, st].filter(Boolean).join(' · ');
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, title, sub, label: [title, city && city !== title ? city + (st ? '/' + st : '') : ''].filter(Boolean).join(', '),
    kind: r.types.some(t => /route|street_address|premise/.test(t)) ? 'rua' : r.types.some(t => /locality|administrative_area|sublocality/.test(t)) ? 'cidade' : 'local' };
}
const google = {
  async geocode(q, limit) {
    const u = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    Object.entries({ address: q, key: GOOGLE_KEY, language: 'pt-BR', region: 'br' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await getJSON(u);
    if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') throw new HttpError(502, 'google geocode ' + j.status);
    return (j.results || []).slice(0, limit).map(fmtGoogle);
  },
  async reverse(lat, lng) {
    const u = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    Object.entries({ latlng: `${lat},${lng}`, key: GOOGLE_KEY, language: 'pt-BR' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await getJSON(u);
    return j.results && j.results[0] ? fmtGoogle(j.results[0]).label : null;
  }
};
const geo = () => (PROVIDER === 'google' ? google : osm);

async function geocodeAny(q, limit, bias) {
  try { return await geo().geocode(q, limit, bias); }
  catch (e) { if (PROVIDER === 'google') return osm.geocode(q, limit, bias); throw e; }
}

// ---------- CEP ----------
async function byCEP(raw) {
  const cep = String(raw).replace(/\D/g, '');
  if (cep.length !== 8) throw new HttpError(400, 'CEP deve ter 8 dígitos');
  const d = await getJSON(`https://viacep.com.br/ws/${cep}/json/`);
  if (!d || d.erro) throw new HttpError(404, 'CEP não encontrado');
  const fmt = cep.slice(0, 5) + '-' + cep.slice(5);
  const queries = [];
  if (d.logradouro) queries.push(`${d.logradouro}, ${d.localidade}, ${d.uf}`);
  if (d.bairro) queries.push(`${d.bairro}, ${d.localidade}, ${d.uf}`);
  queries.push(`${d.localidade}, ${d.uf}`);
  for (const q of queries) {
    const r = await geocodeAny(q, 1).catch(() => []);
    if (r.length) {
      const title = d.logradouro || d.bairro || d.localidade;
      return [{ lat: r[0].lat, lng: r[0].lng, title, kind: 'cep', cep: fmt, precision: q === queries[0] && d.logradouro ? 'rua' : 'aproximada',
        sub: `CEP ${fmt} · ${[d.bairro, d.localidade + '/' + d.uf].filter(Boolean).join(' · ')}`,
        label: `${title}, ${d.localidade}/${d.uf} (CEP ${fmt})` }];
    }
  }
  throw new HttpError(404, 'CEP encontrado, mas sem coordenadas');
}

// ---------- veículos ----------
// Valores típicos de mercado (editáveis na tela). factor/cap ajustam o tempo quando a rota vem de um perfil de carro.
const VEHICLES = {
  van:     { name: 'Van',      h: 2.7, w: 2.0, l: 6.0,  t: 3.5, axles: 2, factor: 0.97, cap: 100, ors: 'delivery' },
  toco:    { name: 'Toco',     h: 3.8, w: 2.6, l: 10.0, t: 16,  axles: 2, factor: 0.88, cap: 80,  ors: 'goods' },
  truck:   { name: 'Caminhão', h: 4.2, w: 2.6, l: 14.0, t: 23,  axles: 3, factor: 0.85, cap: 80,  ors: 'hgv' },
  carreta: { name: 'Carreta',  h: 4.4, w: 2.6, l: 18.6, t: 45,  axles: 5, factor: 0.80, cap: 80,  ors: 'hgv' }
};
const ORS_KEY = (process.env.ORS_API_KEY || '').trim();
const ROUTING = ORS_KEY ? 'ors' : 'osm';
function vehicleFrom(q) {
  const id = VEHICLES[q.get('vehicle')] ? q.get('vehicle') : 'toco';
  const d = VEHICLES[id];
  const clamp = (k, min, max) => { const n = parseFloat(q.get(k)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : null; };
  return { id, ...d,
    h: clamp('h', 1.5, 4.95) ?? d.h, l: clamp('l', 3, 30) ?? d.l, t: clamp('t', 1, 74) ?? d.t,
    axles: Math.round(clamp('axles', 2, 9) ?? d.axles), avoidTolls: q.get('tolls') === 'avoid' };
}
function topRoads(steps) {
  const by = new Map();
  steps.forEach(s => { const n = (s.name || '').split(' · ')[0]; if (n) by.set(n, (by.get(n) || 0) + s.distance); });
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]).join(', ');
}
function haversine(a, b) {
  const R = 6371e3, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- rotas: OSRM (perfil carro, tempo ajustado ao veículo) ----------
const OSRM = ['https://routing.openstreetmap.de/routed-car/route/v1/driving/', 'https://router.project-osrm.org/route/v1/driving/'];
const DIR = { uturn: 'Faça o retorno', 'sharp right': 'Vire acentuadamente à direita', right: 'Vire à direita', 'slight right': 'Mantenha-se à direita', straight: 'Siga em frente', 'slight left': 'Mantenha-se à esquerda', left: 'Vire à esquerda', 'sharp left': 'Vire acentuadamente à esquerda' };
const ANG = { uturn: 180, 'sharp right': 135, right: 90, 'slight right': 45, straight: 0, 'slight left': -45, left: -90, 'sharp left': -135 };
const SIDE = m => /right/.test(m || '') ? 'à direita' : /left/.test(m || '') ? 'à esquerda' : '';
function osrmText(s) {
  const { type, modifier: m, exit } = s.maneuver, side = SIDE(m);
  switch (type) {
    case 'depart': return 'Saia da origem';
    case 'arrive': return 'Chegada ao destino' + (side ? ` (${side})` : '');
    case 'turn': return DIR[m] || 'Vire';
    case 'new name': return 'Continue';
    case 'continue': return m && m !== 'straight' ? DIR[m] : 'Continue em frente';
    case 'merge': return 'Entre na via' + (side ? ' ' + side : '');
    case 'on ramp': return 'Pegue o acesso' + (side ? ' ' + side : '');
    case 'off ramp': return 'Pegue a saída' + (side ? ' ' + side : '');
    case 'fork': return 'Na bifurcação, mantenha-se' + (side ? ' ' + side : '');
    case 'end of road': return 'No fim da via, ' + (DIR[m] || 'vire').toLowerCase();
    case 'roundabout': case 'rotary': return exit ? `Na rotatória, pegue a ${exit}ª saída` : 'Entre na rotatória';
    case 'roundabout turn': return 'Na rotatória, ' + (DIR[m] || 'siga').toLowerCase();
    case 'exit roundabout': case 'exit rotary': return 'Saia da rotatória';
    default: return DIR[m] || 'Continue';
  }
}
function osrmKind(s) {
  const { type, modifier: m } = s.maneuver;
  if (type === 'depart' || type === 'arrive') return type;
  if (/roundabout|rotary/.test(type)) return 'roundabout';
  if (m === 'uturn') return 'uturn';
  return 'turn';
}
// tempo de cada trecho recalculado: velocidade do carro × fator do veículo, limitada à velocidade máxima do veículo
function adjustedDuration(steps, v) {
  return steps.reduce((sum, s) => {
    if (!s.distance || !s.duration) return sum + (s.duration || 0);
    const kmh = Math.min((s.distance / s.duration) * 3.6 * v.factor, v.cap);
    return sum + s.distance / (kmh / 3.6);
  }, 0);
}
async function osrmRoute(a, b, v) {
  let last;
  for (const base of OSRM) {
    for (const exclude of v.avoidTolls ? [true, false] : [false]) {
      try {
        const j = await getJSON(`${base}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=true&alternatives=true${exclude ? '&exclude=toll' : ''}`, {}, 20000)
          .catch(e => { if (e.body && e.body.code) return e.body; throw e; });
        if (j.code === 'NoRoute') throw new HttpError(404, 'Não existe rota viária entre esses pontos');
        if (j.code !== 'Ok') { last = new HttpError(502, j.code); continue; }
        const routes = j.routes.slice(0, 3).map(r => {
          const raw = r.legs.flatMap(l => l.steps), steps = [];
          raw.forEach((s, i) => {
            if (s.maneuver.type === 'new name' && raw[i - 1] && raw[i - 1].name === s.name) return;
            steps.push({ text: osrmText(s), name: [s.name, s.ref && s.ref !== s.name ? s.ref : ''].filter(Boolean).join(' · '), distance: s.distance,
              loc: [s.maneuver.location[1], s.maneuver.location[0]], kind: osrmKind(s), angle: ANG[s.maneuver.modifier] ?? 0 });
          });
          return { distance: r.distance, duration: adjustedDuration(raw, v), summary: r.legs.map(l => l.summary).filter(Boolean).join(', ') || topRoads(steps),
            coords: r.geometry.coordinates.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]), steps };
        });
        return { provider: 'osm', truckRules: false, tollsAvoided: exclude, routes };
      } catch (e) { if (e.status === 404) throw e; last = e; }
    }
  }
  throw last || new HttpError(502, 'Servidor de rotas indisponível');
}

// ---------- rotas: OpenRouteService (perfil caminhão, respeita altura/peso/comprimento) ----------
const ORS_ANG = { 0: -90, 1: 90, 2: -135, 3: 135, 4: -45, 5: 45, 6: 0, 12: -30, 13: 30 };
async function orsRoute(a, b, v) {
  const body = {
    coordinates: [[a.lng, a.lat], [b.lng, b.lat]], language: 'pt', units: 'm', instructions: true, preference: 'recommended',
    options: { vehicle_type: v.ors, profile_params: { restrictions: { height: v.h, width: v.w, length: v.l, weight: v.t, axleload: +(v.t / v.axles).toFixed(1) } } }
  };
  if (v.avoidTolls) body.options.avoid_features = ['tollways'];
  if (haversine(a, b) < 90000) body.alternative_routes = { target_count: 2, weight_factor: 1.4, share_factor: 0.6 };
  const call = bd => getJSON('https://api.openrouteservice.org/v2/directions/driving-hgv/geojson', {
    method: 'POST', body: JSON.stringify(bd), headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json', Authorization: ORS_KEY }
  }, 25000);
  let j;
  try { j = await call(body); }
  catch (e) {
    const code = e.body && e.body.error && e.body.error.code;
    if (code === 2009 || code === 2010) throw new HttpError(404, 'Não há rota para este veículo entre esses pontos (verifique dimensões e peso)');
    if (body.alternative_routes) { delete body.alternative_routes; j = await call(body); } else throw e;
  }
  const routes = (j.features || []).slice(0, 3).map(f => {
    const coords = f.geometry.coordinates;
    const steps = f.properties.segments.flatMap(s => s.steps).map(s => {
      const [x, y] = coords[s.way_points[0]];
      const name = s.name && s.name !== '-' && !s.instruction.includes(s.name) ? s.name : '';
      return { text: s.instruction, name, distance: s.distance, loc: [y, x],
        kind: s.type === 11 ? 'depart' : s.type === 10 ? 'arrive' : (s.type === 7 || s.type === 8) ? 'roundabout' : s.type === 9 ? 'uturn' : 'turn',
        angle: ORS_ANG[s.type] ?? 0, _road: s.name && s.name !== '-' ? s.name : '' };
    });
    const summary = topRoads(steps.map(s => ({ name: s._road, distance: s.distance })));
    steps.forEach(s => delete s._road);
    return { distance: f.properties.summary.distance, duration: f.properties.summary.duration, summary,
      coords: coords.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]), steps };
  });
  if (!routes.length) throw new HttpError(404, 'Não há rota para este veículo entre esses pontos');
  return { provider: 'ors', truckRules: true, tollsAvoided: v.avoidTolls, routes };
}

async function route(a, b, v) {
  if (ROUTING === 'ors') {
    try { return await orsRoute(a, b, v); }
    catch (e) { if (e.status === 404) throw e; console.error('ORS falhou, usando OSRM:', e.message); }
  }
  return osrmRoute(a, b, v);
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const routes = {
  '/api/config': async () => ({ geocoder: PROVIDER, routing: ROUTING, vehicles: VEHICLES }),
  '/api/geocode': async q => {
    const text = (q.get('q') || '').trim().slice(0, 200);
    if (text.length < 3) return [];
    const limit = Math.min(Math.max(parseInt(q.get('limit')) || 6, 1), 8);
    const bias = q.get('near') ? parsePt(q.get('near'), 'near') : null;
    const bkey = bias ? `${bias.lat.toFixed(1)},${bias.lng.toFixed(1)}` : '';
    return cached(`g|${PROVIDER}|${text.toLowerCase()}|${limit}|${bkey}`, 864e5, () => geocodeAny(text, limit, bias));
  },
  '/api/reverse': async q => {
    const lat = num(q.get('lat'), 'lat'), lng = num(q.get('lng'), 'lng');
    const label = await cached(`r|${PROVIDER}|${lat.toFixed(5)},${lng.toFixed(5)}`, 864e5, () => geo().reverse(lat, lng).catch(() => null));
    return { label: label || `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  },
  '/api/cep': async q => { const c = String(q.get('cep') || '').replace(/\D/g, ''); return cached(`c|${PROVIDER}|${c}`, 864e5, () => byCEP(c)); },
  '/api/route': async q => {
    const a = parsePt(q.get('from'), 'from'), b = parsePt(q.get('to'), 'to');
    const v = vehicleFrom(q);
    const k = `x|${ROUTING}|${v.id}|${v.h}|${v.l}|${v.t}|${v.axles}|${v.avoidTolls}|${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    return cached(k, 36e5, () => route(a, b, v));
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, geocoder: PROVIDER, routing: ROUTING });
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Método não permitido' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: 'Muitas consultas em pouco tempo. Aguarde um minuto.' });
    const h = routes[url.pathname];
    if (!h) return send(res, 404, { error: 'Rota da API não encontrada' });
    try { return send(res, 200, await h(url.searchParams), undefined, { 'Cache-Control': 'no-store' }); }
    catch (e) {
      const status = e.status || 502;
      if (status >= 500) console.error(url.pathname, e.message);
      return send(res, status, { error: status >= 500 ? 'Serviço externo indisponível no momento. Tente de novo.' : e.message });
    }
  }
  // arquivos estáticos
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Proibido', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`Roteirizador ouvindo na porta ${PORT} · endereços: ${PROVIDER} · rotas: ${ROUTING}`));
module.exports = { server, osrmText, adjustedDuration, VEHICLES };
