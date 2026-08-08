const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const { test } = require('node:test');

function createMockGluetun({ failAt = -1 } = {}) {
  const requests = [];
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString();
      const body = bodyText ? JSON.parse(bodyText) : null;
      requests.push({
        method: req.method,
        pathname: new URL(req.url, 'http://127.0.0.1').pathname,
        body,
      });

      if (requestCount++ === failAt) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: body.status }));
    });
  });

  return { server, requests };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close(error => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForApp(port) {
  const url = `http://127.0.0.1:${port}/api/instances`;
  const deadline = Date.now() + 5000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`App returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw lastError || new Error('Timed out waiting for app');
}

function stopChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.once('error', resolve);
    child.kill();
  });
}

async function startApp(upstreamPort) {
  const port = await getFreePort();
  const path = process.env.PATH;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...(path ? { PATH: path } : {}),
      PORT: String(port),
      GLUETUN_CONTROL_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForApp(port);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    port,
    close: () => stopChild(child),
  };
}

function assertVpnStatusRequests(requests) {
  for (const request of requests) {
    assert.equal(request.method, 'PUT');
    assert.equal(request.pathname, '/v1/vpn/status');
  }
}

test('per-instance restart stops before starting', async () => {
  const upstream = createMockGluetun();
  let upstreamAddress;
  let app;
  try {
    upstreamAddress = await listen(upstream.server);
    app = await startApp(upstreamAddress.port);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/1/vpn/restart`, { method: 'PUT' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { ok: true, status: 'running' } });
    assertVpnStatusRequests(upstream.requests);
    assert.deepEqual(upstream.requests.map(r => r.body), [
      { status: 'stopped' },
      { status: 'running' },
    ]);
  } finally {
    await app?.close();
    await upstreamAddress?.close();
  }
});

test('legacy restart stops before starting', async () => {
  const upstream = createMockGluetun();
  let upstreamAddress;
  let app;
  try {
    upstreamAddress = await listen(upstream.server);
    app = await startApp(upstreamAddress.port);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/vpn/restart`, { method: 'PUT' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { ok: true, status: 'running' } });
    assertVpnStatusRequests(upstream.requests);
    assert.deepEqual(upstream.requests.map(r => r.body), [
      { status: 'stopped' },
      { status: 'running' },
    ]);
  } finally {
    await app?.close();
    await upstreamAddress?.close();
  }
});

test('restart does not start when stop fails', async () => {
  const upstream = createMockGluetun({ failAt: 0 });
  let upstreamAddress;
  let app;
  try {
    upstreamAddress = await listen(upstream.server);
    app = await startApp(upstreamAddress.port);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/vpn/restart`, { method: 'PUT' });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'Upstream error' });
    assertVpnStatusRequests(upstream.requests);
    assert.equal(upstream.requests.length, 1);
    assert.deepEqual(upstream.requests[0].body, { status: 'stopped' });
  } finally {
    await app?.close();
    await upstreamAddress?.close();
  }
});

test('restart returns an upstream error when start fails', async () => {
  const upstream = createMockGluetun({ failAt: 1 });
  let upstreamAddress;
  let app;
  try {
    upstreamAddress = await listen(upstream.server);
    app = await startApp(upstreamAddress.port);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/1/vpn/restart`, { method: 'PUT' });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'Upstream error' });
    assertVpnStatusRequests(upstream.requests);
    assert.deepEqual(upstream.requests.map(r => r.body), [
      { status: 'stopped' },
      { status: 'running' },
    ]);
  } finally {
    await app?.close();
    await upstreamAddress?.close();
  }
});
