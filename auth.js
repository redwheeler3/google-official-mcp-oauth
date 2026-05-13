#!/usr/bin/env node
/**
 * Google Official MCP OAuth Bootstrapper
 *
 * Usage:
 *   node auth.js gmail
 *   node auth.js calendar
 *   node auth.js both
 *
 * This script performs a first-time Google OAuth browser flow and writes token
 * files in the exact locations/formats expected by bridge.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const SECRETS_DIR = path.join(__dirname, 'secrets');
const TOKEN_BASE_DIR = path.join(os.homedir(), '.config', 'google-official-mcp-oauth');

const SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
  ],
};

const TOKEN_TARGETS = {
  gmail: {
    label: 'Gmail',
    scopes: SCOPES.gmail,
    tokenPath: path.join(TOKEN_BASE_DIR, 'gmail', 'tokens.json'),
  },
  calendar: {
    label: 'Calendar',
    scopes: SCOPES.calendar,
    tokenPath: path.join(TOKEN_BASE_DIR, 'calendar', 'tokens.json'),
  },
};

function log(msg) {
  process.stderr.write('[auth] ' + msg + '\n');
}

function usage(exitCode = 0) {
  console.log(`Google Official MCP OAuth Bootstrapper

Usage:
  node auth.js gmail
  node auth.js calendar
  node auth.js both

This opens a browser, asks Google for consent, receives the localhost callback,
and writes token files for the bridge scripts.

Token outputs:
  Gmail:    ${TOKEN_TARGETS.gmail.tokenPath}
  Calendar: ${TOKEN_TARGETS.calendar.tokenPath}
`);
  process.exit(exitCode);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeTokens(tokenPath, tokens) {
  ensureDir(path.dirname(tokenPath));
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
}

function readOAuthClient() {
  if (!fs.existsSync(SECRETS_DIR)) {
    throw new Error(`Missing secrets/ folder. Create it and drop your Google OAuth client JSON inside.`);
  }

  const files = fs.readdirSync(SECRETS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No JSON file found in secrets/. Download your OAuth client JSON from Google Cloud Console and drop it in the secrets/ folder.`);
  }

  const filePath = path.join(SECRETS_DIR, files[0]);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const installed = raw.installed || raw.web || raw;
  const client_id = installed.client_id;
  const client_secret = installed.client_secret;

  if (!client_id || !client_secret) {
    throw new Error(`Could not find client_id/client_secret in secrets/${files[0]}. Ensure it is a valid Google OAuth client JSON.`);
  }

  return { client_id, client_secret };
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;

  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function startCodeServer(expectedState) {
  let settleCode;
  const codePromise = new Promise((resolve, reject) => { settleCode = { resolve, reject }; });

  const listenPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const host = req.headers.host || 'localhost';
        const url = new URL(req.url, `http://${host}`);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>OAuth failed</h1><p>${escapeHtml(error)}</p>`);
          server.close();
          settleCode.reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Invalid OAuth callback</h1><p>You can close this tab.</p>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization complete</h1><p>You can close this tab and return to Cline/VS Code.</p>');
        server.close();
        settleCode.resolve(code);
      } catch (e) {
        server.close();
        settleCode.reject(e);
      }
    });

    server.once('error', e => {
      reject(e);
      settleCode.reject(e);
    });
    server.listen(0, '127.0.0.1', () => {
      server.on('error', e => {
        server.close();
        process.stderr.write('[auth] ERROR: OAuth callback server error: ' + e.message + '\n');
      });
      const port = server.address().port;
      log(`Listening for OAuth callback at http://localhost:${port}/`);
      resolve({ port, codePromise });
    });
  });

  return listenPromise;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function authOne(kind) {
  const target = TOKEN_TARGETS[kind];
  if (!target) usage(1);

  const client = readOAuthClient();
  const state = crypto.randomBytes(16).toString('hex');
  const callback = await startCodeServer(state);
  const oauthClient = new OAuth2Client({
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUri: `http://localhost:${callback.port}/`,
  });

  const scopes = target.scopes;
  const authUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
  });

  log(`Starting ${target.label} OAuth flow...`);
  log('Opening browser for Google authorization...');
  openBrowser(authUrl);

  const code = await callback.codePromise;
  log('Authorization code received; exchanging for tokens...');

  const { tokens: tokenData } = await oauthClient.getToken(code);

  if (!tokenData.refresh_token) {
    throw new Error('Google did not return a refresh_token. Re-run with consent, or revoke app access and try again.');
  }

  const now = Date.now();
  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    scope: tokenData.scope || scopes.join(' '),
    token_type: tokenData.token_type || 'Bearer',
    expiry_date: tokenData.expiry_date || now + ((tokenData.expires_in || 3600) * 1000),
  };

  writeTokens(target.tokenPath, tokens);
  log(`${target.label} tokens written to ${target.tokenPath}`);
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  if (!arg || arg === '-h' || arg === '--help' || arg === 'help') usage(0);

  if (arg === 'both') {
    await authOne('gmail');
    await authOne('calendar');
  } else if (arg === 'gmail' || arg === 'calendar') {
    await authOne(arg);
  } else {
    usage(1);
  }

  log('Done. You can now use bridge.js gmail and/or bridge.js calendar.');
}

main().catch(e => {
  process.stderr.write('[auth] ERROR: ' + e.message + '\n');
  process.exit(1);
});