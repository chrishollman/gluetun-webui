const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('dashboard exposes a Reconnect action', () => {
  const source = fs.readFileSync('src/public/app.js', 'utf8');
  assert.match(source, /i\$\{id\}-btn-reconnect/);
  assert.match(source, /vpnAction\(id, 'restart'\)/);
  assert.match(source, /Reconnecting/);
  assert.match(source, /VPN reconnect command sent/);
});
