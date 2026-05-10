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
 * files in the exact locations/formats expected by gmail-bridge.js and
 * calendar-bridge.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CLIENT_SECRET_EXAMPLE_FILE = path.join(__dirname, 'client_secret.example.json');
const CLIENT_SECRET_LOCAL_FILE = path.join(__dirname, 'client_secret.local.json');
const CLIENT_INFO_FILE = path.join(__dirname, 'client-info.json');
const CLIENT_INFO_LOCAL_FILE = path.join(__dirname, 'client-info.local.json');
const OAUTH_SCOPES_LOCAL_FILE = path.join(__dirname, 'oauth-scopes.local.json');

const SCOPE_PROFILES = {
  fullTooling: {
    gmail: [
      // Superset sufficient for official Gmail MCP read/search/draft/label operations.
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.settings.basic',
    ],
    calendar: [
      // Superset sufficient for official Calendar MCP read/freebusy/create/update operations.
      'https://www.googleapis.com/auth/calendar',
    ],
  },
  leastPrivilegeDocumented: {
    gmail: [
      // Google's documented baseline for the official Gmail MCP server.
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    calendar: [
      // Google's documented read/freebusy baseline for the official Calendar MCP server.
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
  },
};

const TOKEN_TARGETS = {
  gmail: {
    label: 'Gmail',
    get scopes() { return getScopes('gmail'); },
    tokenPath: path.join(os.homedir(), '.gmail-mcp', 'credentials.json'),
    write(tokens) {
      ensureDir(path.dirname(this.tokenPath));
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    },
  },
  calendar: {
    label: 'Calendar',
    get scopes() { return getScopes('calendar'); },
    tokenPath: path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
    write(tokens) {
      ensureDir(path.dirname(this.tokenPath));
      fs.writeFileSync(this.tokenPath, JSON.stringify({ normal: tokens }, null, 2), 'utf8');
    },
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

function readOAuthClient() {
  const secretFile = firstExistingFile([CLIENT_SECRET_LOCAL_FILE]);
  const infoFile = firstExistingFile([CLIENT_INFO_LOCAL_FILE, CLIENT_INFO_FILE]);

  if (secretFile) {
    const raw = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
    const c = raw.installed || raw.web || raw;
    const client = {
      client_id: c.client_id,
      client_secret: c.client_secret,
      auth_uri: c.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
      token_uri: c.token_uri || 'https://oauth2.googleapis.com/token',
    };
    assertRealOAuthClient(client, secretFile);
    return client;
  }

  if (infoFile) {
    const c = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    const client = {
      client_id: c.client_id,
      client_secret: c.client_secret,
      auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    };
    assertRealOAuthClient(client, infoFile);
    return client;
  }

  throw new Error(`Missing OAuth client file. Create ${CLIENT_INFO_LOCAL_FILE} or ${CLIENT_SECRET_LOCAL_FILE}. See ${CLIENT_SECRET_EXAMPLE_FILE} for the Google credential file shape.`);
}

function firstExistingFile(files) {
  return files.find(fp => fs.existsSync(fp));
}

function assertRealOAuthClient(client, sourceFile) {
  if (!client.client_id || !client.client_secret || client.client_id.includes('YOUR_') || client.client_secret.includes('YOUR_')) {
    throw new Error(`OAuth client_id/client_secret missing or still templated in ${sourceFile}. Create an ignored local credential file instead.`);
  }
}

function readScopeConfig() {
  if (!fs.existsSync(OAUTH_SCOPES_LOCAL_FILE)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(OAUTH_SCOPES_LOCAL_FILE, 'utf8'));
}

function getScopes(kind) {
  const localConfig = readScopeConfig();
  if (localConfig && Array.isArray(localConfig[kind])) {
    return localConfig[kind];
  }

  const profileName = (localConfig && localConfig.profile) || process.env.GOOGLE_MCP_SCOPE_PROFILE || 'fullTooling';
  const localProfile = localConfig && localConfig.profiles && localConfig.profiles[profileName];
  const profile = localProfile || SCOPE_PROFILES[profileName] || SCOPE_PROFILES.fullTooling;
  return profile[kind];
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

function postForm(tokenUri, form) {
  return new Promise((resolve, reject) => {
    const url = new URL(tokenUri);
    const body = new URLSearchParams(form).toString();

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`${parsed.error}: ${parsed.error_description || data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Bad token response HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function createCodeServer(expectedState) {
  let settle;
  const codePromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });

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
        settle.reject(new Error(`OAuth error: ${error}`));
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
      settle.resolve(code);
    } catch (e) {
      server.close();
      settle.reject(e);
    }
  });

  return { server, codePromise };
}

function startCodeServer(port, expectedState) {
  const { server, codePromise } = createCodeServer(expectedState);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', e => {
        server.close();
        process.stderr.write('[auth] ERROR: OAuth callback server error: ' + e.message + '\n');
      });
      const actualPort = server.address().port;
      log(`Listening for OAuth callback at http://localhost:${actualPort}/`);
      resolve({ server, codePromise, port: actualPort });
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function authOne(kind) {
  const target = TOKEN_TARGETS[kind];
  if (!target) usage(1);

  const client = readOAuthClient();
  if (!client.client_id || !client.client_secret) {
    throw new Error('OAuth client_id/client_secret missing from credential files.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const callback = await startOAuthCallback(state);

  const authUrl = new URL(client.auth_uri);
  const scopes = target.scopes;
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', callback.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  log(`Starting ${target.label} OAuth flow...`);
  log('Opening browser for Google authorization...');
  openBrowser(authUrl.toString());

  const code = await callback.codePromise;
  log('Authorization code received; exchanging for tokens...');

  const tokenData = await postForm(client.token_uri, {
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: callback.redirectUri,
    grant_type: 'authorization_code',
  });

  if (!tokenData.refresh_token) {
    throw new Error('Google did not return a refresh_token. Re-run with consent, or revoke app access and try again.');
  }

  const now = Date.now();
  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    scope: tokenData.scope || scopes.join(' '),
    token_type: tokenData.token_type || 'Bearer',
    expiry_date: now + ((tokenData.expires_in || 3600) * 1000),
  };

  target.write(tokens);
  log(`${target.label} tokens written to ${target.tokenPath}`);
}

async function startOAuthCallback(expectedState) {
  // Google Desktop OAuth clients normally accept loopback redirect URIs with
  // arbitrary ports. Prefer port 80 when available (exactly http://localhost/)
  // and fall back to a random loopback port without pre-binding/releasing ports.
  try {
    const { codePromise } = await startCodeServer(80, expectedState);
    return {
      redirectUri: 'http://localhost/',
      codePromise,
    };
  } catch (e) {
    log(`Port 80 OAuth callback unavailable (${e.message}); falling back to a random loopback port.`);
  }

  const { codePromise, port } = await startCodeServer(0, expectedState);
  return {
    redirectUri: `http://localhost:${port}/`,
    codePromise,
  };
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

  log('Done. You can now use gmail-bridge.js and/or calendar-bridge.js.');
}

main().catch(e => {
  process.stderr.write('[auth] ERROR: ' + e.message + '\n');
  process.exit(1);
});