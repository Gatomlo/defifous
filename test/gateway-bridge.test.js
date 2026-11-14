'use strict';
// Connexion centralisee de node-gateway : req.gateway avec le droit « admin » authentifie la requete, a chaque
// requete et sans cookie (coupe des que la passerelle ne garantit plus). Un « membre », un anonyme ou un droit
// nul n'obtiennent rien. Le mot de passe local reste valable. Hors passerelle : inchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranch-gw-'));
process.env.DATA_DIR = dir;
const express = require('express');
const app = require('../server/index');

let srv, base;
const gw = (role) => ({ 'x-test-gateway': JSON.stringify({ app: 'ranch', role, user: { login: 'anim', name: 'Anim', email: null, isSuper: false } }) });
const get = (p, headers = {}) => fetch(base + p, { headers });

test.before(async () => {
  const outer = express();
  outer.use((req, res, next) => { const h = req.get('x-test-gateway'); if (h) req.gateway = JSON.parse(h); next(); });
  outer.use('/ranch', app);
  srv = http.createServer(outer);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/ranch`;
});
test.after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); setImmediate(() => process.exit(0)); });

test('droit admin de la passerelle -> acces authentifie, sans cookie', async () => {
  assert.equal((await (await get('/api/auth/status', gw('admin'))).json()).authenticated, true);
  const r = await get('/api/sessions', gw('admin'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('coupe aussitot quand la passerelle ne garantit plus', async () => {
  assert.equal((await get('/api/sessions', gw('admin'))).status, 200);
  assert.equal((await get('/api/sessions')).status, 401);
});

test('un simple membre, un anonyme ou un droit nul n\'obtiennent rien', async () => {
  for (const h of [gw('member'), gw(null), {}]) {
    assert.equal((await get('/api/sessions', h)).status, 401);
    assert.equal((await (await get('/api/auth/status', h)).json()).authenticated, false);
  }
});

test('creation du mot de passe : refusee au premier visiteur derriere la passerelle', async () => {
  const setup = (h) => fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ password: 'motdepasse-solide' }) });
  const anon = { 'x-test-gateway': JSON.stringify({ app: 'ranch', role: null, user: null }) };
  assert.equal((await setup(anon)).status, 403);
  assert.equal((await setup(gw('member'))).status, 403);
  assert.equal((await (await get('/api/auth/status')).json()).configured, false, 'rien n\'a ete cree');
});

test('mot de passe local inchange : creation (hors passerelle) puis acces', async () => {
  const standalone = http.createServer(app);
  await new Promise((r) => standalone.listen(0, '127.0.0.1', r));
  let r = await fetch(`http://127.0.0.1:${standalone.address().port}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'motdepasse-solide' }) });
  standalone.close();
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/api/sessions', { cookie })).status, 200);
  assert.equal((await get('/api/sessions')).status, 401);
});
