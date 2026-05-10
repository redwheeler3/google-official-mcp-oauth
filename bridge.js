#!/usr/bin/env node
/** Unified launcher for Google's official Gmail and Calendar MCP bridges. */
'use strict';

const path = require('path');
const os = require('os');
const { createGoogleMcpBridge } = require('./google-mcp-bridge');

const SERVICE_CONFIGS = {
  gmail: () => {
    const credentialsFile = path.join(os.homedir(), '.gmail-mcp', 'credentials.json');
    return {
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
      readCredentials: tokenFile => tokenFile.normal || tokenFile,
      writeCredentials: ({ tokenFile, credentials, writeJson }) => {
        tokenFile.normal = credentials;
        writeJson(credentialsFile, tokenFile);
      },
    };
  },
};

function usage(exitCode = 0) {
  console.error('Usage: node bridge.js <gmail|calendar>');
  process.exit(exitCode);
}

function runService(service) {
  const createConfig = SERVICE_CONFIGS[service];
  if (!createConfig) usage(1);

  const bridge = createGoogleMcpBridge(createConfig());
  return bridge.main();
}

if (require.main === module) {
  const service = (process.argv[2] || '').toLowerCase();
  if (!service || service === '-h' || service === '--help' || service === 'help') usage(0);

  runService(service).catch(e => {
    process.stderr.write(`[${service || 'bridge'}-bridge] FATAL: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { runService };