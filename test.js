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
    { distance: 500, name: 'Av. Paulista', maneuver: { type: 'depart', location: [-46.6559, -23.5614] } },
    { distance: 90000, name: 'Rodovia dos Bandeirantes', ref: 'SP-348', maneuver: { type: 'on ramp', modifier: 'slight right', location: [-46.7, -23.5] } },
    { distance: 5000, name: '', maneuver: { type: 'roundabout', exit: 2, location: [-47, -22.95] } },
    { distance: 0, name: '', maneuver: { type: 'arrive', location: [-47.0608, -22.9056] } }] }] }] });
  return realFetch(url, opts);
};
const { server } = require('./server.js');

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await realFetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    let r = await get('/api/config'); assert.strictEqual(r.body.provider, 'osm');
    r = await get('/api/geocode?q=masp&near=-23.5,-46.6'); assert.strictEqual(r.body[0].title, 'MASP'); assert.match(r.body[0].label, /SP$/);
    r = await get('/api/cep?cep=01310-200'); assert.match(r.body[0].label, /CEP 01310-200/); assert.strictEqual(r.body[0].precision, 'rua');
    r = await get('/api/cep?cep=00000000'); assert.strictEqual(r.status, 404);
    r = await get('/api/cep?cep=123'); assert.strictEqual(r.status, 400);
    r = await get('/api/reverse?lat=-23.56&lng=-46.65'); assert.match(r.body.label, /Paulista, 1578/);
    r = await get('/api/route?from=-23.5614,-46.6559&to=-22.9056,-47.0608&mode=car');
    const rt = r.body.routes[0];
    assert.strictEqual(rt.distance, 96400); assert.deepStrictEqual(rt.coords[0], [-23.5614, -46.6559]);
    assert.deepStrictEqual(rt.steps.map(s => s.text), ['Saia da origem', 'Pegue o acesso à direita', 'Na rotatória, pegue a 2ª saída', 'Chegada ao destino']);
    r = await get('/api/route?from=abc&to=1,2'); assert.strictEqual(r.status, 400);
    const before = calls.length; await get('/api/geocode?q=masp&near=-23.5,-46.6'); assert.strictEqual(calls.length, before, 'cache');
    r = await get('/'); assert.strictEqual(r.status, 200);
    r = await get('/../server.js'); assert.notStrictEqual(r.status, 200);
    console.log('OK — todos os testes passaram');
  } catch (e) { console.error('FALHOU:', e.message); process.exitCode = 1; }
  server.close();
});
