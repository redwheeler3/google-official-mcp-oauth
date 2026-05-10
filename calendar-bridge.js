#!/usr/bin/env node
/** Google Calendar launcher for the shared Google official MCP stdio bridge. */
'use strict';

const path = require('path');
const os = require('os');
const { createGoogleMcpBridge } = require('./google-mcp-bridge');

const credentialsFile = path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const bridge = createGoogleMcpBridge({
  name: 'Calendar',
  logPrefix: 'calendar-bridge',
  credentialsFile,
  mcpHostname: 'calendarmcp.googleapis.com',
  mcpPath: '/mcp/v1',
  readCredentials: tokenFile => tokenFile.normal || tokenFile,
  writeCredentials: ({ tokenFile, credentials, writeJson }) => {
    tokenFile.normal = credentials;
    writeJson(credentialsFile, tokenFile);
  },
});

bridge.main().catch(e => {
  process.stderr.write('[calendar-bridge] FATAL: ' + e.message + '\n');
  process.exit(1);
});