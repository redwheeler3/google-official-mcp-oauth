#!/usr/bin/env node
/** Unified launcher for Google's official Gmail and Calendar MCP bridges. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { OAuth2Client } = require('google-auth-library');

const CLIENT_INFO_FILE = path.join(__dirname, 'client-info.local.json');
const CLIENT_INFO_FALLBACK_FILE = path.join(__dirname, 'client-info.json');

const SERVICE_CONFIGS = {
  gmail: () => {
    const credentialsFile = path.join(os.homedir(), '.gmail-mcp', 'credentials.json');
    return {
      name: 'Gmail',
      logPrefix: 'gmail-bridge',
      credentialsFile,
      mcpHostname: 'gmailmcp.googleapis.com',
      mcpPath: '/mcp/v1',
    };
  },
  calendar: () => {
    const credentialsFile = path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');
    return {
      name: 'Calendar',
      logPrefix: 'calendar-bridge',
      credentialsFile,
      mcpHostname: 'calendarmcp.googleapis.com',
      mcpPath: '/mcp/v1',
      tokenKey: 'normal',
    };
  },
};

function createGoogleMcpBridge(config) {
  let tokenFile = null;
  let credentials = null;
  let oauthClient = null;
  let processing = Promise.resolve();
  let inFlight = 0;
  let stdinClosed = false;
  let transport = null;
  const pendingRequests = new Map();

  function log(msg) { process.stderr.write(`[${config.logPrefix}] ${msg}\n`); }

  function readJson(fp) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { log(`ERROR reading ${fp}: ${e.message}`); process.exit(1); }
  }

  function writeJson(fp, data) {
    try { fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e) { log(`WARN: Could not write ${fp}: ${e.message}`); }
  }

  function readClientInfo() {
    const fp = fs.existsSync(CLIENT_INFO_FILE) ? CLIENT_INFO_FILE : CLIENT_INFO_FALLBACK_FILE;
    const info = readJson(fp);
    if (!info.client_id || !info.client_secret || info.client_id.includes('YOUR_') || info.client_secret.includes('YOUR_')) {
      log(`ERROR: OAuth client info missing or still templated in ${fp}. Create ${CLIENT_INFO_FILE}.`);
      process.exit(1);
    }
    return info;
  }

  async function ensureFreshToken() {
    const { token } = await oauthClient.getAccessToken();
    if (!token) throw new Error('OAuth client did not return an access token. Re-run auth.js to refresh credentials.');
    return token;
  }

  function persistTokens(tokens) {
    credentials = { ...credentials, ...tokens };
    oauthClient.setCredentials(credentials);
    writeCredentials();
    log('Token refreshed successfully.');
  }

  function readCredentials() {
    return config.tokenKey ? tokenFile[config.tokenKey] || tokenFile : tokenFile;
  }

  function writeCredentials() {
    if (config.tokenKey) tokenFile[config.tokenKey] = credentials;
    else Object.assign(tokenFile, credentials);
    writeJson(config.credentialsFile, tokenFile);
  }

  function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

  async function authFetch(url, init = {}) {
    const accessToken = await ensureFreshToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer ' + accessToken);

    const res = await fetch(url, { ...init, headers });
    if (res.status !== 404 || (init.method || 'GET').toUpperCase() !== 'POST') return res;

    const msg = parseRequestBody(init.body);
    if (!msg || msg.id === undefined || msg.id === null) return res;

    await res.body?.cancel();
    return new Response(JSON.stringify(jsonRpcError(msg.id, -32601, 'Method not found')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function parseRequestBody(body) {
    try {
      if (typeof body === 'string') return JSON.parse(body);
      if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
    } catch (_) {
      return null;
    }
    return null;
  }

  async function sendToTransport(msg) {
    const id = msg && msg.id !== undefined && msg.id !== null ? msg.id : null;
    let responsePromise = null;
    if (id !== null) {
      responsePromise = new Promise(resolve => pendingRequests.set(id, resolve));
    }

    try {
      await transport.send(msg);
      if (responsePromise) await responsePromise;
    } finally {
      if (id !== null) pendingRequests.delete(id);
    }
  }

  function handleTransportMessage(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
    if (msg && msg.id !== undefined && pendingRequests.has(msg.id)) {
      pendingRequests.get(msg.id)();
    }
  }

  function maybeExit() {
    if (stdinClosed && inFlight === 0) process.exit(0);
  }

  function enqueueLine(line) {
    processing = processing
      .then(() => handleLine(line))
      .catch(e => log(`Unexpected queue error: ${e.message}`))
      .finally(maybeExit);
  }

  async function handleLine(line) {
    line = line.trim(); if (!line) return;
    let msgId = null;
    inFlight++;
    try {
      const msg = JSON.parse(line); msgId = msg.id !== undefined ? msg.id : null;
      log(`→ ${msg.method || '(response)'} id=${msgId}`);
      await sendToTransport(msg);
    } catch (e) {
      log(`Error: ${e.message}`);
      if (msgId !== null) process.stdout.write(JSON.stringify(jsonRpcError(msgId, -32603, e.message)) + '\n');
    } finally {
      inFlight--;
    }
  }

  async function main() {
    log(`Starting ${config.name} Official MCP Bridge...`);
    tokenFile = readJson(config.credentialsFile);
    credentials = readCredentials();
    const clientInfo = readClientInfo();
    oauthClient = new OAuth2Client({
      clientId: clientInfo.client_id,
      clientSecret: clientInfo.client_secret,
      eagerRefreshThresholdMillis: 60000,
      forceRefreshOnFailure: true,
    });
    oauthClient.setCredentials(credentials);
    oauthClient.on('tokens', persistTokens);
    transport = new StreamableHTTPClientTransport(new URL(`https://${config.mcpHostname}${config.mcpPath}`), { fetch: authFetch });
    transport.onmessage = handleTransportMessage;
    transport.onerror = e => log(`Transport error: ${e.message}`);
    await transport.start();
    const pendingLines = [];
    let ready = false;
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => ready ? enqueueLine(line) : pendingLines.push(line));
    rl.on('close', () => { stdinClosed = true; if (ready && pendingLines.length === 0) processing.finally(maybeExit); });
    await ensureFreshToken();
    log(`Ready. Proxying stdio → https://${config.mcpHostname}${config.mcpPath}`);
    ready = true;
    for (const line of pendingLines) enqueueLine(line);
    pendingLines.length = 0;
    if (stdinClosed) processing.finally(maybeExit);
  }

  return main();
}

function usage(exitCode = 0) {
  console.error('Usage: node bridge.js <gmail|calendar>');
  process.exit(exitCode);
}

function main() {
  const createConfig = SERVICE_CONFIGS[service];
  if (!createConfig) usage(1);

  return createGoogleMcpBridge(createConfig());
}

const service = (process.argv[2] || '').toLowerCase();
if (!service || service === '-h' || service === '--help' || service === 'help') usage(0);

main().catch(e => {
  process.stderr.write(`[${service || 'bridge'}-bridge] FATAL: ${e.message}\n`);
  process.exit(1);
});