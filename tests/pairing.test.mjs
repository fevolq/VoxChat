import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { Store } from '../src/store.js';
import { VoxChat } from '../src/service.js';
import { pairingLink, pairingImage } from '../client/pairing.js';
import { command, fakeDsh, fixture } from './helpers.mjs';

function decodeImage(link) {
  const svg = decodeURIComponent(pairingImage(link, qrcode).split(',').slice(1).join(','));
  const size = Number(/viewBox="0 0 (\d+) /.exec(svg)[1]);
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const match of svg.matchAll(/M(\d+),(\d+)l(\d+),0 0,(\d+)/g)) {
    const [, x, y, width, height] = match.map(Number);
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
      const offset = (row * size + col) * 4; pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
  }
  const decoded = jsQR(pixels, size, size);
  assert.equal(decoded?.data, link);
  return new URL(decoded.data);
}

test('six-character codes expire at five minutes and renew only through an explicit admin command', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const store = new Store(':memory:'), service = new VoxChat(store, fakeDsh(), {});
  t.after(() => store.close());
  const first = command(service, { action: 'addDevice', name: '手机' }).result;
  assert.match(first.code, /^[A-Z0-9]{6}$/); assert.equal(first.expires - Date.now(), 300_000);
  assert.equal(JSON.stringify(service.view()).includes(first.code), false);
  assert.throws(() => command(service, { action: 'batch', operations: [
    { action: 'refreshPairing', deviceId: first.id }, { action: 'bindDevice', deviceId: first.id, workspaceId: 'missing' },
  ] }));
  const hashBefore = store.device(first.id).pairing_hash;
  t.mock.timers.tick(299_999); service.view();
  assert.equal(store.device(first.id).pairing_hash, hashBefore);
  const second = command(service, { action: 'refreshPairing', deviceId: first.id }).result;
  assert.notEqual(first.code, second.code); assert.equal(second.expires - Date.now(), 300_000);
  assert.throws(() => service.pair(first.code), { code: 'INVALID_PAIRING_CODE' });
  t.mock.timers.tick(300_000);
  assert.throws(() => service.pair(second.code), { code: 'INVALID_PAIRING_CODE' });
  const expiredHash = store.device(first.id).pairing_hash;
  service.view(); service.view();
  assert.equal(store.device(first.id).pairing_hash, expiredHash);
  assert.equal(store.device(first.id).expires, second.expires);
  const third = command(service, { action: 'refreshPairing', deviceId: first.id }).result;
  const paired = service.pair(' ' + third.code.toLowerCase() + ' ');
  assert.equal(paired.deviceId, first.id);
  assert.throws(() => command(service, { action: 'refreshPairing', deviceId: first.id }), { code: 'ALREADY_PAIRED' });
  assert.equal(store.authenticate(paired.token).id, first.id);
});

test('the displayed QR image decodes independently and its one-use code pairs through HTTP', async t => {
  const f = await fixture(t);
  const pending = command(f.service, { action: 'addDevice', name: '扫码设备' }).result;
  const link = pairingLink('https://dsh.example.test:3080/', pending.code);
  const uri = decodeImage(link);
  assert.equal(uri.protocol, 'voxchat:'); assert.equal(uri.hostname, 'pair');
  assert.equal(uri.searchParams.get('server'), 'https://dsh.example.test:3080');
  assert.deepEqual([...uri.searchParams.keys()].sort(), ['code', 'server']);
  const response = await f.request('/pair', { method: 'POST', body: { code: uri.searchParams.get('code') } });
  assert.equal(response.status, 200); assert.equal((await response.json()).deviceId, pending.id);
  assert.equal((await f.request('/pair', { method: 'POST', body: { code: uri.searchParams.get('code') } })).status, 401);
  for (const origin of ['https://user:secret@example.test', 'file:///tmp/a']) {
    assert.throws(() => pairingLink(origin, pending.code));
  }
});

test('QR links reject loopback addresses that cannot identify the DSH host on a phone', () => {
  for (const origin of ['http://localhost:3080', 'http://app.localhost:3080', 'http://127.0.0.1:3080', 'http://[::1]:3080', 'http://0.0.0.0:3080', 'http://[::]:3080']) {
    assert.throws(() => pairingLink(origin, 'ABC234'), /本机回环地址/);
  }
});

test('pairing attempts are throttled and device tokens cannot refresh codes or manage voices', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await f.request('/pair', { method: 'POST', body: { code: 'BAD000' } })).status, 401);
  assert.equal((await f.request('/pair', { method: 'POST', body: { code: 'BAD000' } })).status, 429);
  assert.equal((await f.request('/refreshPairing', { method: 'POST', body: { deviceId: f.pair.deviceId } })).status, 404);
  assert.equal((await f.request('/voices', { method: 'POST', body: { voiceId: 'other' } })).status, 405);
});
