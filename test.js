// Teste da API com provedores externos simulados: node test.js
'use strict';
const assert = require('node:assert');
const realFetch = global.fetch;
const calls = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url); calls.push(u);
  const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('viacep')) return u.includes('00000000') ? json({ erro: true }) : json({ logradouro: 'Avenida Paulista', bairro: 'Bela Vista', localidade: 'São Paulo', uf: 'SP' });
  if (u.includes('photon') && u.includes('reverse')) return json({ features: [{ geometry: { coordinates: [-46.65, -23.56] }, properties: { street: 'Avenida Paulista', housenumber: '1578', city: 'São Paulo', state: 'São Paulo' } }] });
  if (u.includes('photon')) return json({ features: [{ geometry: { coordinates: [-46.65, -23.56] }, properties: { name: 'MASP', street: 'Avenida Paulista', city: 'São Paulo', state: 'São Paulo' } }] });
  if (u.includes('/route/v1/')) return json({ code: 'Ok', routes: [{ distance: 96400, duration: 4300, geometry: { coordinates: [[-46.6559, -23.5614], [-47.0608, -22.9056]] }, legs: [{ summary: 'Rodovia dos Bandeirantes', steps: [
    { distance: 500, duration: 60, name: 'Av. Paulista', maneuver: { type: 'depart', location: [-46.6559, -23.5614] } },
    { distance: 90000, duration: 3000, name: 'Rodovia dos Bandeirantes', ref: 'SP-348', maneuver: { type: 'on ramp', modifier: 'slight right', location: [-46.7, -23.5] } },
    { distance: 5000, duration: 240, name: '', maneuver: { type: 'roundabout', exit: 2, location: [-47, -22.95] } },
    { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: [-47.0608, -22.9056] } }] }] }] });
  if (u.includes('openrouteservice')) {
    const body = JSON.parse(opts.body); orsBodies.push(body);
    if (body.options.profile_params.restrictions.height > 4.9) return new Response(JSON.stringify({ error: { code: 2009, message: 'Route could not be found' } }), { status: 404 });
    return new Response(JSON.stringify({ type: 'FeatureCollection', features: [{ geometry: { coordinates: [[-46.6559, -23.5614, 0], [-46.7, -23.5], [-47.0608, -22.9056]] }, properties: {
      summary: { distance: 98000, duration: 5600 }, segments: [{ steps: [
        { distance: 800, duration: 120, type: 11, instruction: 'Siga para o noroeste na Avenida Paulista', name: 'Avenida Paulista', way_points: [0, 1] },
        { distance: 97200, duration: 5480, type: 1, instruction: 'Vire à direita', name: 'Rodovia dos Bandeirantes', way_points: [1, 2] },
        { distance: 0, duration: 0, type: 10, instruction: 'Chegada ao destino', name: '-', way_points: [2, 2] }] }] } }] }), { status: 200 });
  }
  return realFetch(url, opts);
};
const orsBodies = [];
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await realFetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    let r = await get('/api/config'); assert.strictEqual(r.body.routing, 'osm');
    r = await get('/api/geocode?q=masp&near=-23.5,-46.6'); assert.strictEqual(r.body[0].title, 'MASP'); assert.match(r.body[0].label, /SP$/);
    r = await get('/api/cep?cep=01310-200'); assert.match(r.body[0].label, /CEP 01310-200/); assert.strictEqual(r.body[0].precision, 'rua');
    r = await get('/api/cep?cep=00000000'); assert.strictEqual(r.status, 404);
    r = await get('/api/cep?cep=123'); assert.strictEqual(r.status, 400);
    r = await get('/api/reverse?lat=-23.56&lng=-46.65'); assert.match(r.body.label, /Paulista, 1578/);
    r = await get('/api/route?from=-23.5614,-46.6559&to=-22.9056,-47.0608&vehicle=van');
    const van = r.body.routes[0].duration;
    r = await get('/api/route?from=-23.5614,-46.6559&to=-22.9056,-47.0608&vehicle=carreta&tolls=avoid');
    assert.strictEqual(r.body.provider, 'osm'); assert.strictEqual(r.body.truckRules, false); assert.strictEqual(r.body.tollsAvoided, true);
    assert.ok(calls.some(c => c.includes('exclude=toll')), 'exclude=toll enviado');
    const rt = r.body.routes[0];
    assert.ok(rt.duration > van && van > 3300, `carreta (${rt.duration}) mais lenta que van (${van})`);
    assert.strictEqual(rt.distance, 96400); assert.deepStrictEqual(rt.coords[0], [-23.5614, -46.6559]);
    assert.deepStrictEqual(rt.steps.map(s => s.text), ['Saia da origem', 'Pegue o acesso à direita', 'Na rotatória, pegue a 2ª saída', 'Chegada ao destino']);
    r = await get('/api/route?from=abc&to=1,2'); assert.strictEqual(r.status, 400);
    const before = calls.length; await get('/api/geocode?q=masp&near=-23.5,-46.6'); assert.strictEqual(calls.length, before, 'cache');
    r = await get('/'); assert.strictEqual(r.status, 200);
    r = await get('/../server.js'); assert.notStrictEqual(r.status, 200);
    console.log('OK — modo OSM');
  } catch (e) { console.error('FALHOU (OSM):', e.message); process.exitCode = 1; }
  server.close();
  // segundo servidor, agora com chave do OpenRouteService
  process.env.ORS_API_KEY = 'teste';
  delete require.cache[require.resolve('./server.js')];
  const ors = require('./server.js').server;
  ors.listen(0, async () => {
    const base2 = `http://127.0.0.1:${ors.address().port}`;
    const get2 = async p => { const r = await realFetch(base2 + p); return { status: r.status, body: await r.json().catch(() => null) }; };
    try {
      let r = await get2('/api/route?from=-23.5614,-46.6559&to=-22.9056,-47.0608&vehicle=truck&h=4.3&t=23&axles=3&tolls=avoid');
      assert.strictEqual(r.body.provider, 'ors'); assert.strictEqual(r.body.truckRules, true);
      const b = orsBodies.at(-1);
      assert.strictEqual(b.options.profile_params.restrictions.height, 4.3);
      assert.strictEqual(b.options.profile_params.restrictions.axleload, 7.7);
      assert.deepStrictEqual(b.options.avoid_features, ['tollways']);
      assert.ok(b.alternative_routes, 'alternativas pedidas abaixo de 90 km em linha reta');
      const rt = r.body.routes[0];
      assert.strictEqual(rt.summary, 'Rodovia dos Bandeirantes, Avenida Paulista');
      assert.deepStrictEqual(rt.steps.map(s => s.kind), ['depart', 'turn', 'arrive']);
      assert.strictEqual(rt.steps[1].name, 'Rodovia dos Bandeirantes'); assert.strictEqual(rt.steps[0].name, '');
      r = await get2('/api/route?from=-23.5614,-46.6559&to=-22.9056,-47.0608&vehicle=truck&h=4.95');
      assert.strictEqual(r.status, 404);
      console.log('OK — modo OpenRouteService');
    } catch (e) { console.error('FALHOU (ORS):', e.message); process.exitCode = 1; }
    ors.close();
  });
});
