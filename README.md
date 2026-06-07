# Google Official Gmail/Calendar/Drive MCP Adapter for Cline

Minimal cross-platform local adapter for using Google's official Gmail, Google Calendar, and Google Drive MCP servers from Cline on Windows, macOS, and Linux.

## Why this exists

Google's official Gmail, Calendar, and Drive MCP servers are remote Streamable HTTP servers. Cline expects a local stdio MCP process. `bridge.js` is the small adapter between the two.

It also avoids shell quoting problems, especially on Windows, by never passing `Authorization: Bearer <token>` through command-line arguments. Instead, it lets `google-auth-library` refresh access tokens and gives them to the MCP SDK in-process through an `authProvider`.

Access tokens are short-lived, commonly around one hour. The adapter uses the long-lived refresh token in the local token files to refresh access tokens automatically. You only need to re-run `auth.js` if the refresh token is missing, revoked, invalidated, or new scopes are needed.

## Quick start

```sh
cd /path/to/google-official-mcp-oauth
npm install
# Drop your Google OAuth client JSON into the secrets/ folder (see below)
node auth.js all
```

Use an individual service name, such as `node auth.js drive`, if you only want one token.

## OAuth credentials

Download your OAuth client JSON from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and drop it directly into the `secrets/` folder. No renaming needed — the scripts auto-detect any `.json` file in that folder.

The `secrets/` folder is gitignored, so your credentials stay local.

## Cline MCP settings

The Cline settings should point at the bridge script with the service name as the second argument.

Windows example:

```json
"gmail-official": {
  "autoApprove": [],
  "disabled": false,
  "timeout": 120,
  "type": "stdio",
  "command": "node",
  "args": [
    "C:\\path\\to\\google-official-mcp-oauth\\bridge.js",
    "gmail"
  ]
},
"calendar-official": {
  "autoApprove": [],
  "disabled": false,
  "timeout": 120,
  "type": "stdio",
  "command": "node",
  "args": [
    "C:\\path\\to\\google-official-mcp-oauth\\bridge.js",
    "calendar"
  ]
},
"drive-official": {
  "autoApprove": [],
  "disabled": false,
  "timeout": 120,
  "type": "stdio",
  "command": "node",
  "args": [
    "C:\\path\\to\\google-official-mcp-oauth\\bridge.js",
    "drive"
  ]
}
```

macOS/Linux example:

```json
"gmail-official": {
  "autoApprove": [],
  "disabled": false,
  "timeout": 120,
  "type": "stdio",
  "command": "node",
  "args": [
    "/Users/you/path/to/google-official-mcp-oauth/bridge.js",
    "gmail"
  ]
},
"calendar-official": {
  "autoApprove": [],
  "disabled": false,
  "timeout": 120,
  "type": "stdio",
  "command": "node",
  "args": [
    "/Users/you/path/to/google-official-mcp-oauth/bridge.js",
    "calendar"
  ]
},
"drive-official": {
  "autoApprove": [],
  "disabled": false,
  "timeout": 120,
  "type": "stdio",
  "command": "node",
  "args": [
    "/Users/you/path/to/google-official-mcp-oauth/bridge.js",
    "drive"
  ]
}
```

If this folder is moved, update those paths.

## Token files used by the adapter

The adapter reads and refreshes tokens at these locations:

```text
Gmail:    ~/.config/google-official-mcp-oauth/gmail/tokens.json
Calendar: ~/.config/google-official-mcp-oauth/calendar/tokens.json
Drive:    ~/.config/google-official-mcp-oauth/drive/tokens.json
```

These files contain long-lived OAuth refresh tokens. Treat them like passwords.

## OAuth scopes

`auth.js` uses scopes that support the currently working Gmail label/search/draft operations, Calendar create/update behavior, and official Drive MCP file search/read/create/copy behavior:

- Gmail: `gmail.modify`, `gmail.settings.basic`
- Calendar: `calendar`
- Drive: `drive.readonly`, `drive.file`

If a tool fails with insufficient permissions after scopes change in the future, update the built-in scopes in `auth.js` and re-run `node auth.js all`.

## First-time setup or token recovery

If installing on a new machine, or if refresh tokens are deleted/invalidated:

1. Clone the repo and run `npm install`
2. Drop your Google OAuth client JSON into `secrets/`
3. Run `node auth.js all` (opens browser for Google consent)

That's it. The bridges are ready to use.

## Testing the bridges

Without using Cline, you can test the bridges with:

```sh
node test-bridge.js bridge.js gmail
node test-bridge.js bridge.js calendar
node test-bridge.js bridge.js drive
```

Expected behavior:

- `initialize` returns `StatelessServer vESF`
- `tools/list` returns tools
- `resources/list` returns JSON-RPC `-32601 Method not found`, which is expected because Google's official servers are tools-only

## Files

- `bridge.js` — tiny stdio-to-Streamable-HTTP adapter for Gmail, Calendar, and Drive
- `auth.js` — first-time OAuth bootstrap/recovery script
- `secrets/` — gitignored folder for your Google OAuth client JSON (download from Cloud Console, drop it in)
- `test-bridge.js` — local test harness for bridge validation
