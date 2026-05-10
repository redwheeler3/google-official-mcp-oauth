#!/usr/bin/env node
/** Shared stdio-to-HTTPS MCP bridge for Google's official Workspace MCP servers. */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const CLIENT_INFO_FILE = path.join(__dirname, 'client-info.local.json');
const CLIENT_INFO_FALLBACK_FILE = path.join(__dirname, 'client-info.json');

function createGoogleMcpBridge(config) {
  let tokenFile = null;
  let credentials = null;
  let clientInfo = null;
  let accessToken = null;
  let sessionId = null;

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

  function doRefreshToken() {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        client_id: clientInfo.client_id,
        client_secret: clientInfo.client_secret,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token',
      }).toString();
      const req = https.request({
        hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            parsed.error ? reject(new Error(`Token refresh error: ${parsed.error} – ${parsed.error_description}`)) : resolve(parsed);
          } catch (_) { reject(new Error(`Bad token response: ${data}`)); }
        });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  async function ensureFreshToken() {
    const now = Date.now();
    if (!accessToken || (credentials.expiry_date || 0) - 60000 < now) {
      log('Access token expired or missing — refreshing...');
      const tok = await doRefreshToken();
      accessToken = tok.access_token;
      credentials.access_token = accessToken;
      credentials.expiry_date = now + tok.expires_in * 1000;
      config.writeCredentials({ tokenFile, credentials, writeJson });
      log('Token refreshed successfully.');
    }
  }

  function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

  function mcpPost(msgObj) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(msgObj);
      const headers = {
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + accessToken, 'Content-Length': Buffer.byteLength(body),
      };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const req = https.request({ hostname: config.mcpHostname, path: config.mcpPath, method: 'POST', headers }, (res) => {
        const sid = res.headers['mcp-session-id'];
        if (sid && sid !== sessionId) { sessionId = sid; log(`MCP session ID: ${sessionId}`); }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (ct.includes('text/event-stream')) return readSse(res, resolve, reject);
        if (res.statusCode === 202) { res.resume(); return resolve([]); }
        if (res.statusCode === 404) {
          res.resume();
          return resolve(msgObj.id !== undefined && msgObj.id !== null ? [jsonRpcError(msgObj.id, -32601, 'Method not found')] : []);
        }
        readJsonResponse(res, msgObj, resolve, reject);
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  function readSse(res, resolve, reject) {
    const results = [];
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString('utf8');
      let boundary;
      while ((boundary = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, boundary); buf = buf.slice(boundary + 2);
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6).trim();
            if (payload && payload !== '[DONE]') { try { results.push(JSON.parse(payload)); } catch (_) {} }
          }
        }
      }
    });
    res.on('end', () => resolve(results)); res.on('error', reject);
  }

  function readJsonResponse(res, msgObj, resolve, reject) {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
      if (!data.trim()) return resolve([]);
      try { resolve([JSON.parse(data)]); }
      catch (_) {
        log(`Non-JSON HTTP ${res.statusCode} — treating as method not found`);
        resolve(msgObj.id !== undefined && msgObj.id !== null ? [jsonRpcError(msgObj.id, -32601, `HTTP ${res.statusCode}: ${data.slice(0, 120)}`)] : []);
      }
    });
    res.on('error', reject);
  }

  async function handleLine(line) {
    line = line.trim(); if (!line) return;
    let msgId = null;
    try {
      const msg = JSON.parse(line); msgId = msg.id !== undefined ? msg.id : null;
      log(`→ ${msg.method || '(response)'} id=${msgId}`);
      await ensureFreshToken();
      for (const r of await mcpPost(msg)) process.stdout.write(JSON.stringify(r) + '\n');
    } catch (e) {
      log(`Error: ${e.message}`);
      if (msgId !== null) process.stdout.write(JSON.stringify(jsonRpcError(msgId, -32603, e.message)) + '\n');
    }
  }

  async function main() {
    log(`Starting ${config.name} Official MCP Bridge...`);
    tokenFile = readJson(config.credentialsFile);
    credentials = config.readCredentials(tokenFile);
    clientInfo = readClientInfo();
    accessToken = credentials.access_token || null;
    const pendingLines = [];
    let ready = false, stdinClosed = false;
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => ready ? handleLine(line) : pendingLines.push(line));
    rl.on('close', () => { stdinClosed = true; if (ready && pendingLines.length === 0) process.exit(0); });
    await ensureFreshToken();
    log(`Ready. Proxying stdio → https://${config.mcpHostname}${config.mcpPath}`);
    ready = true;
    for (const line of pendingLines) await handleLine(line);
    pendingLines.length = 0;
    if (stdinClosed) process.exit(0);
  }

  return { main };
}

module.exports = { createGoogleMcpBridge };