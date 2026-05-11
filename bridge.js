#!/usr/bin/env node
/**
 * Tiny stdio -> Google official MCP bridge for Cline.
 *
 * Cline talks stdio. Google's official Gmail/Calendar MCP servers talk
 * Streamable HTTP and need Google OAuth access tokens. This adapter keeps the
 * local surface small: read existing token files, let google-auth-library
 * refresh access tokens, and let the MCP SDK handle the HTTP transport.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { OAuth2Client } = require('google-auth-library');

const SECRETS_DIR = path.join(__dirname, 'secrets');

const SERVICES = {
  gmail: {
    name: 'Gmail',
    logPrefix: 'gmail-bridge',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    credentialsFile: path.join(os.homedir(), '.gmail-mcp', 'credentials.json'),
  },
  calendar: {
    name: 'Calendar',
    logPrefix: 'calendar-bridge',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    credentialsFile: path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
    tokenKey: 'normal',
  },
};

function usage(exitCode = 0) {
  console.error('Usage: node bridge.js <gmail|calendar>');
  process.exit(exitCode);
}

const serviceName = (process.argv[2] || '').toLowerCase();
if (!serviceName || serviceName === '-h' || serviceName === '--help' || serviceName === 'help') usage(0);

const service = SERVICES[serviceName];
if (!service) usage(1);

const log = msg => process.stderr.write(`[${service.logPrefix}] ${msg}\n`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log(`ERROR reading ${file}: ${e.message}`);
    process.exit(1);
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log(`WARN: Could not write ${file}: ${e.message}`);
  }
}

function readClientInfo() {
  if (!fs.existsSync(SECRETS_DIR)) {
    log(`ERROR: Missing secrets/ folder. Create it and drop your Google OAuth client JSON inside.`);
    process.exit(1);
  }

  const files = fs.readdirSync(SECRETS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    log(`ERROR: No JSON file found in secrets/. Download your OAuth client JSON from Google Cloud Console and drop it in the secrets/ folder.`);
    process.exit(1);
  }

  const raw = readJson(path.join(SECRETS_DIR, files[0]));
  const installed = raw.installed || raw.web || raw;
  const client_id = installed.client_id;
  const client_secret = installed.client_secret;

  if (!client_id || !client_secret) {
    log(`ERROR: Could not find client_id/client_secret in secrets/${files[0]}. Ensure it is a valid Google OAuth client JSON.`);
    process.exit(1);
  }

  return { client_id, client_secret };
}

function createOAuthClient(tokenFile, credentials) {
  const clientInfo = readClientInfo();
  const oauthClient = new OAuth2Client({
    clientId: clientInfo.client_id,
    clientSecret: clientInfo.client_secret,
    eagerRefreshThresholdMillis: 60000,
    forceRefreshOnFailure: true,
  });

  oauthClient.setCredentials(credentials);
  oauthClient.on('tokens', tokens => {
    Object.assign(credentials, tokens);
    oauthClient.setCredentials(credentials);

    if (service.tokenKey) tokenFile[service.tokenKey] = credentials;
    else Object.assign(tokenFile, credentials);

    writeJson(service.credentialsFile, tokenFile);
    log('Token refreshed successfully.');
  });

  return oauthClient;
}

function createAuthProvider(oauthClient) {
  return {
    tokens: async () => {
      const { token } = await oauthClient.getAccessToken();
      if (!token) throw new Error('OAuth client did not return an access token. Re-run auth.js.');
      return { access_token: token, token_type: 'Bearer' };
    },
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function parseJsonRpcBody(body) {
  try {
    if (typeof body === 'string') return JSON.parse(body);
    if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  } catch (_) {
    return null;
  }
  return null;
}

async function googleMcpFetch(url, init = {}) {
  const res = await fetch(url, init);

  // Google's tools-only MCP endpoints currently return an HTML 404 page for
  // unsupported JSON-RPC methods such as resources/list. Cline probes these,
  // so convert that endpoint quirk into a normal JSON-RPC "Method not found".
  if (res.status !== 404 || (init.method || 'GET').toUpperCase() !== 'POST') return res;

  const msg = parseJsonRpcBody(init.body);
  if (!msg || msg.id === undefined || msg.id === null) return res;

  await res.body?.cancel();
  return new Response(JSON.stringify(jsonRpcError(msg.id, -32601, 'Method not found')), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function main() {
  log(`Starting ${service.name} Official MCP Bridge...`);

  const tokenFile = readJson(service.credentialsFile);
  const credentials = service.tokenKey ? tokenFile[service.tokenKey] || tokenFile : tokenFile;
  const oauthClient = createOAuthClient(tokenFile, credentials);
  const transport = new StreamableHTTPClientTransport(new URL(service.url), {
    authProvider: createAuthProvider(oauthClient),
    fetch: googleMcpFetch,
  });

  const pendingRequests = new Map();
  let processing = Promise.resolve();
  let inFlight = 0;
  let stdinClosed = false;

  transport.onmessage = msg => {
    process.stdout.write(JSON.stringify(msg) + '\n');
    if (msg && msg.id !== undefined && pendingRequests.has(msg.id)) pendingRequests.get(msg.id)();
  };
  transport.onerror = e => log(`Transport error: ${e.message}`);

  await transport.start();
  await oauthClient.getAccessToken();
  log(`Ready. Proxying stdio -> ${service.url}`);

  function maybeExit() {
    if (stdinClosed && inFlight === 0) process.exit(0);
  }

  async function sendToTransport(msg) {
    const id = msg && msg.id !== undefined && msg.id !== null ? msg.id : null;
    const responsePromise = id === null ? null : new Promise(resolve => pendingRequests.set(id, resolve));
    try {
      await transport.send(msg);
      if (responsePromise) await responsePromise;
    } finally {
      if (id !== null) pendingRequests.delete(id);
    }
  }

  async function handleLine(line) {
    line = line.trim();
    if (!line) return;

    let msgId = null;
    inFlight++;
    try {
      const msg = JSON.parse(line);
      msgId = msg.id !== undefined ? msg.id : null;
      log(`-> ${msg.method || '(response)'} id=${msgId}`);
      await sendToTransport(msg);
    } catch (e) {
      log(`Error: ${e.message}`);
      if (msgId !== null) process.stdout.write(JSON.stringify(jsonRpcError(msgId, -32603, e.message)) + '\n');
    } finally {
      inFlight--;
    }
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    processing = processing
      .then(() => handleLine(line))
      .catch(e => log(`Unexpected queue error: ${e.message}`))
      .finally(maybeExit);
  });
  rl.on('close', () => {
    stdinClosed = true;
    processing.finally(maybeExit);
  });
}

main().catch(e => {
  process.stderr.write(`[${serviceName || 'bridge'}-bridge] FATAL: ${e.message}\n`);
  process.exit(1);
});