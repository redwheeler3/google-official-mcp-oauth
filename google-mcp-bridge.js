#!/usr/bin/env node
/** Shared stdio-to-HTTPS MCP bridge for Google's official Workspace MCP servers. */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLIENT_INFO_FILE = path.join(__dirname, 'client-info.local.json');
const CLIENT_INFO_FALLBACK_FILE = path.join(__dirname, 'client-info.json');

function createGoogleMcpBridge(config) {
  let tokenFile = null;
  let credentials = null;
  let clientInfo = null;
  let accessToken = null;
  let sessionId = null;
  let refreshPromise = null;
  let processing = Promise.resolve();
  let inFlight = 0;
  let stdinClosed = false;

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

  async function doRefreshToken() {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientInfo.client_id,
        client_secret: clientInfo.client_secret,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { throw new Error(`Bad token response HTTP ${res.status}: ${text}`); }

    if (parsed.error) throw new Error(`Token refresh error: ${parsed.error} – ${parsed.error_description}`);
    return parsed;
  }

  async function ensureFreshToken() {
    const now = Date.now();
    if (!accessToken || (credentials.expiry_date || 0) - 60000 < now) {
      log('Access token expired or missing — refreshing...');
      if (!refreshPromise) {
        refreshPromise = doRefreshToken().finally(() => { refreshPromise = null; });
      }
      const tok = await refreshPromise;
      accessToken = tok.access_token;
      credentials.access_token = accessToken;
      credentials.expiry_date = now + tok.expires_in * 1000;
      config.writeCredentials({ tokenFile, credentials, writeJson });
      log('Token refreshed successfully.');
    }
  }

  function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

  async function mcpPost(msgObj) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + accessToken,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(`https://${config.mcpHostname}${config.mcpPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(msgObj),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid && sid !== sessionId) { sessionId = sid; log(`MCP session ID: ${sessionId}`); }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) return readSse(res);
    if (res.status === 202) return [];
    if (res.status === 404) return msgObj.id !== undefined && msgObj.id !== null ? [jsonRpcError(msgObj.id, -32601, 'Method not found')] : [];
    return readJsonResponse(res, msgObj);
  }

  async function readSse(res) {
    const results = [];
    let buf = '';
    const decoder = new TextDecoder();

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buf)) !== null) {
        const rawEvent = buf.slice(0, match.index); buf = buf.slice(match.index + match[0].length);
        readSseEvent(rawEvent, results);
      }
    }

    buf += decoder.decode();
    readSseEvent(buf, results);
    return results;
  }

  function readSseEvent(rawEvent, results) {
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload && payload !== '[DONE]') { try { results.push(JSON.parse(payload)); } catch (_) {} }
      }
    }
  }

  async function readJsonResponse(res, msgObj) {
    const data = await res.text();
    if (!data.trim()) return [];
    try { return [JSON.parse(data)]; }
    catch (_) {
      log(`Non-JSON HTTP ${res.status} — treating as method not found`);
      return msgObj.id !== undefined && msgObj.id !== null ? [jsonRpcError(msgObj.id, -32601, `HTTP ${res.status}: ${data.slice(0, 120)}`)] : [];
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
      await ensureFreshToken();
      for (const r of await mcpPost(msg)) process.stdout.write(JSON.stringify(r) + '\n');
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
    credentials = config.readCredentials(tokenFile);
    clientInfo = readClientInfo();
    accessToken = credentials.access_token || null;
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

  return { main };
}

module.exports = { createGoogleMcpBridge };