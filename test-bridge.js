#!/usr/bin/env node
/**
 * Test harness for the MCP bridge scripts.
 * Sends initialize + tools/list + resources/list to verify graceful 404 handling.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const BRIDGE = process.argv[2] || path.join(__dirname, 'gmail-bridge.js');

console.error(`[test] Testing bridge: ${path.basename(BRIDGE)}`);

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: child.stdout, terminal: false });

rl.on('line', (line) => {
  try {
    const obj = JSON.parse(line);
    const method = obj.result ? 'result' : obj.error ? `error(${obj.error.code})` : '?';
    console.log(`[test] id=${obj.id} → ${method}`);
    if (obj.result && obj.result.tools) {
      console.log(`[test]   tools count: ${obj.result.tools.length}`);
    }
    if (obj.result && obj.result.serverInfo) {
      console.log(`[test]   server: ${obj.result.serverInfo.name} v${obj.result.serverInfo.version}`);
    }
    if (obj.error) {
      console.log(`[test]   error message: ${obj.error.message}`);
    }
  } catch (_) {
    console.log('[test] RAW:', line.slice(0, 80));
  }
});

child.on('exit', (code) => {
  console.error(`[test] Bridge exited with code ${code}`);
});

const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cline-test', version: '1.0' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },  // should get graceful error
];

let idx = 0;
function sendNext() {
  if (idx >= msgs.length) {
    setTimeout(() => {
      console.error('[test] Done — closing.');
      child.stdin.end();
      child.kill();
      process.exit(0);
    }, 1000);
    return;
  }
  const msg = msgs[idx++];
  console.error(`[test] → ${msg.method}`);
  child.stdin.write(JSON.stringify(msg) + '\n');
  setTimeout(sendNext, 2500);
}

sendNext();

// Kill after 20 seconds max
setTimeout(() => {
  console.error('[test] Timeout — force closing.');
  child.stdin.end();
  child.kill();
  process.exit(0);
}, 20000);
