# Google Official Gmail/Calendar MCP Adapter for Cline

Minimal cross-platform local adapter for using Google's official Gmail and Google Calendar MCP servers from Cline on Windows, macOS, and Linux.

## Why this exists

Google's official Gmail and Calendar MCP servers are remote Streamable HTTP servers. Cline expects a local stdio MCP process. `bridge.js` is the small adapter between the two.

It also avoids shell quoting problems, especially on Windows, by never passing `Authorization: Bearer <token>` through command-line arguments. Instead, it lets `google-auth-library` refresh access tokens and gives them to the MCP SDK in-process through an `authProvider`.

Access tokens are short-lived, commonly around one hour. The adapter uses the long-lived refresh token in the local token files to refresh access tokens automatically. You only need to re-run `auth.js` if the refresh token is missing, revoked, invalidated, or new scopes are needed.

## Quick start

```sh
cd /path/to/google-official-mcp-oauth
npm install
# Drop your Google OAuth client JSON into the secrets/ folder (see below)
node auth.js both
```

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
}
```

If this folder is moved, update those paths.

## Token files used by the adapter

The adapter reads and refreshes tokens at these locations:

```text
Gmail:    ~/.config/google-official-mcp-oauth/gmail/tokens.json
Calendar: ~/.config/google-official-mcp-oauth/calendar/tokens.json
```

These files contain long-lived OAuth refresh tokens. Treat them like passwords.

## OAuth scopes

By default, `auth.js` uses scopes that support the currently working Gmail label/search/draft operations and Calendar create/update behavior:

- Gmail: `gmail.modify`, `gmail.settings.basic`
- Calendar: `calendar`

To override scopes, copy `oauth-scopes.example.json` to `oauth-scopes.local.json`, edit the `gmail` and/or `calendar` arrays, then re-run OAuth:

```sh
cp oauth-scopes.example.json oauth-scopes.local.json
nano oauth-scopes.local.json
node auth.js both
```

If a tool fails with insufficient permissions, restore the default scopes shown above and re-run `node auth.js both`.

## First-time setup or token recovery

If installing on a new machine, or if refresh tokens are deleted/invalidated:

1. Clone the repo and run `npm install`
2. Drop your Google OAuth client JSON into `secrets/`
3. Run `node auth.js both` (opens browser for Google consent)

That's it. The bridges are ready to use.

## Testing the bridges

Without using Cline, you can test the bridges with:

```sh
node test-bridge.js bridge.js gmail
node test-bridge.js bridge.js calendar
```

Expected behavior:

- `initialize` returns `StatelessServer vESF`
- `tools/list` returns tools
- `resources/list` returns JSON-RPC `-32601 Method not found`, which is expected because Google's official servers are tools-only

## Files

- `bridge.js` — tiny stdio-to-Streamable-HTTP adapter for Gmail and Calendar
- `auth.js` — first-time OAuth bootstrap/recovery script
- `secrets/` — gitignored folder for your Google OAuth client JSON (download from Cloud Console, drop it in)
- `oauth-scopes.example.json` — optional tracked example for overriding OAuth scopes
- `test-bridge.js` — local test harness for bridge validation
