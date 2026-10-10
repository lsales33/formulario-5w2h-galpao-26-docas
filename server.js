// Roteirizador A→B — servidor HTTP sem dependências (Node >= 18)
// Provedor: OpenStreetMap por padrão; Google Maps Platform quando GOOGLE_MAPS_API_KEY estiver definida.
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
  return { lat, lng, title, sub, label };
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
    return j.map(r => { const parts = r.display_name.split(', '); return { lat: +r.lat, lng: +r.lon, title: parts.slice(0, 2).join(', '), sub: parts.slice(2, 5).join(' · '), label: parts.slice(0, 3).join(', ') }; });
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
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, title, sub, label: [title, city && city !== title ? city + (st ? '/' + st : '') : ''].filter(Boolean).join(', ') };
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
      return [{ lat: r[0].lat, lng: r[0].lng, title, precision: q === queries[0] && d.logradouro ? 'rua' : 'aproximada',
        sub: `CEP ${fmt} · ${[d.bairro, d.localidade + '/' + d.uf].filter(Boolean).join(' · ')}`,
        label: `${title}, ${d.localidade}/${d.uf} (CEP ${fmt})` }];
    }
  }
  throw new HttpError(404, 'CEP encontrado, mas sem coordenadas');
}

// ---------- rotas: OSRM ----------
const OSRM = {
  car: ['https://routing.openstreetmap.de/routed-car/route/v1/driving/', 'https://router.project-osrm.org/route/v1/driving/'],
  bike: ['https://routing.openstreetmap.de/routed-bike/route/v1/driving/'],
  foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/driving/']
};
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
async function osrmRoute(a, b, mode) {
  let last;
  for (const base of OSRM[mode]) {
    try {
      const j = await getJSON(`${base}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`, {}, 20000);
      if (j.code !== 'Ok') { last = new HttpError(j.code === 'NoRoute' ? 404 : 502, j.code === 'NoRoute' ? 'Não existe rota viária entre esses pontos' : j.code); if (j.code === 'NoRoute') break; continue; }
      return j.routes.slice(0, 3).map(r => {
        const steps = [];
        r.legs.flatMap(l => l.steps).forEach((s, i, all) => {
          if (s.maneuver.type === 'new name' && all[i - 1] && all[i - 1].name === s.name) return;
          steps.push({ text: osrmText(s), name: [s.name, s.ref && s.ref !== s.name ? s.ref : ''].filter(Boolean).join(' · '), distance: s.distance,
            loc: [s.maneuver.location[1], s.maneuver.location[0]], kind: osrmKind(s), angle: ANG[s.maneuver.modifier] ?? 0 });
        });
        return { distance: r.distance, duration: r.duration, summary: r.legs.map(l => l.summary).filter(Boolean).join(', '),
          coords: r.geometry.coordinates.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]), steps };
      });
    } catch (e) { last = e; }
  }
  throw last || new HttpError(502, 'Servidor de rotas indisponível');
}

// ---------- rotas: Google Routes API ----------
function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
const G_ANG = { TURN_SLIGHT_LEFT: -45, TURN_SHARP_LEFT: -135, TURN_LEFT: -90, TURN_SLIGHT_RIGHT: 45, TURN_SHARP_RIGHT: 135, TURN_RIGHT: 90, RAMP_LEFT: -45, RAMP_RIGHT: 45, FORK_LEFT: -45, FORK_RIGHT: 45, MERGE: 0, STRAIGHT: 0, NAME_CHANGE: 0 };
async function googleRoute(a, b, mode) {
  const travelMode = { car: 'DRIVE', bike: 'BICYCLE', foot: 'WALK' }[mode];
  const body = {
    origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
    destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
    travelMode, computeAlternativeRoutes: true, languageCode: 'pt-BR', units: 'METRIC'
  };
  if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
  const j = await getJSON('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.description,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation' }
  }, 20000);
  if (!j || !j.routes || !j.routes.length) throw new HttpError(404, 'Não existe rota entre esses pontos');
  return j.routes.slice(0, 3).map(r => {
    const raw = (r.legs || []).flatMap(l => l.steps || []);
    const steps = raw.map((s, i) => {
      const man = (s.navigationInstruction || {}).maneuver || '';
      const kind = i === 0 ? 'depart' : /ROUNDABOUT/.test(man) ? 'roundabout' : /UTURN/.test(man) ? 'uturn' : 'turn';
      const ll = s.startLocation.latLng;
      return { text: (s.navigationInstruction || {}).instructions || 'Continue', name: '', distance: s.distanceMeters || 0, loc: [ll.latitude, ll.longitude], kind, angle: G_ANG[man] ?? 0 };
    });
    steps.push({ text: 'Chegada ao destino', name: '', distance: 0, loc: [b.lat, b.lng], kind: 'arrive', angle: 0 });
    return { distance: r.distanceMeters, duration: parseFloat(r.duration), summary: r.description ? 'via ' + r.description : '',
      coords: decodePolyline(r.polyline.encodedPolyline).map(([y, x]) => [+y.toFixed(5), +x.toFixed(5)]), steps };
  });
}

async function route(a, b, mode) {
  if (PROVIDER === 'google') {
    try { return { provider: 'google', traffic: mode === 'car', routes: await googleRoute(a, b, mode) }; }
    catch (e) { if (e.status === 404) throw e; /* cai para OSM */ }
  }
  return { provider: 'osm', traffic: false, routes: await osrmRoute(a, b, mode) };
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const routes = {
  '/api/config': async () => ({ provider: PROVIDER }),
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
    const mode = OSRM[q.get('mode')] ? q.get('mode') : 'car';
    const k = `x|${PROVIDER}|${mode}|${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    return cached(k, PROVIDER === 'google' && mode === 'car' ? 3e5 : 36e5, () => route(a, b, mode));
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, provider: PROVIDER });
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

if (require.main === module) server.listen(PORT, () => console.log(`Roteirizador ouvindo na porta ${PORT} · provedor: ${PROVIDER}`));
module.exports = { server, decodePolyline, osrmText };
