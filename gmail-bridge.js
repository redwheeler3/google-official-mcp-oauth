#!/usr/bin/env node
/** Gmail launcher for the shared Google official MCP stdio bridge. */
'use strict';

const path = require('path');
const os = require('os');
const { createGoogleMcpBridge } = require('./google-mcp-bridge');

const credentialsFile = path.join(os.homedir(), '.gmail-mcp', 'credentials.json');

const bridge = createGoogleMcpBridge({
  name: 'Gmail',
  logPrefix: 'gmail-bridge',
  credentialsFile,
  mcpHostname: 'gmailmcp.googleapis.com',
  mcpPath: '/mcp/v1',
  readCredentials: tokenFile => tokenFile,
  writeCredentials: ({ tokenFile, credentials, writeJson }) => {
    Object.assign(tokenFile, credentials);
    writeJson(credentialsFile, tokenFile);
  },
});

bridge.main().catch(e => {
  process.stderr.write('[gmail-bridge] FATAL: ' + e.message + '\n');
  process.exit(1);
});