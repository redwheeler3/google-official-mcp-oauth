# Google Official Gmail/Calendar MCP Adapter for Cline

Minimal cross-platform local adapter for using Google's official Gmail and Google Calendar MCP servers from Cline on Windows, macOS, and Linux.

## Why this exists

Google's official Gmail and Calendar MCP servers are remote Streamable HTTP servers. Cline expects a local stdio MCP process. `bridge.js` is the small adapter between the two.

It also avoids shell quoting problems, especially on Windows, by never passing `Authorization: Bearer <token>` through command-line arguments. Instead, it lets `google-auth-library` refresh access tokens and gives them to the MCP SDK in-process through an `authProvider`.

Access tokens are short-lived, commonly around one hour. The adapter uses the long-lived refresh token in the local token files to refresh access tokens automatically. You only need to re-run `auth.js` if the refresh token is missing, revoked, invalidated, or new scopes are needed.

## Files

- `bridge.js` — tiny stdio-to-Streamable-HTTP adapter for Gmail and Calendar
- `auth.js` — first-time OAuth bootstrap/recovery script
- `client-info.example.json` — tracked template for compact OAuth client credentials
- `client-info.local.json` — ignored local OAuth client id/secret required by the scripts
- `oauth-scopes.example.json` — optional tracked example for overriding OAuth scopes
- `test-bridge.js` — local test harness for bridge validation

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
Gmail:    ~/.gmail-mcp/credentials.json
Calendar: ~/.config/google-calendar-mcp/tokens.json
```

These files contain long-lived OAuth refresh tokens. Treat them like passwords.

## OAuth credential files

Real OAuth client secrets should live only in ignored local files:

```text
client-info.local.json
oauth-scopes.local.json
```

Copy `client-info.example.json` to `client-info.local.json`, then fill in your real OAuth client id and secret. The scripts require `client-info.local.json`.

Example `client-info.local.json`:

```json
{
  "client_id": "YOUR_REAL_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_REAL_CLIENT_SECRET"
}
```

## OAuth scopes

By default, `auth.js` uses scopes that support the currently working Gmail label/search/draft operations and Calendar create/update behavior:

- Gmail: `gmail.modify`, `gmail.settings.basic`
- Calendar: `calendar`

To override scopes, copy `oauth-scopes.example.json` to `oauth-scopes.local.json`, edit the `gmail` and/or `calendar` arrays, then re-run OAuth.

Windows:

```cmd
copy oauth-scopes.example.json oauth-scopes.local.json
notepad oauth-scopes.local.json
node auth.js both
```

macOS/Linux:

```sh
cp oauth-scopes.example.json oauth-scopes.local.json
${EDITOR:-nano} oauth-scopes.local.json
node auth.js both
```

If a tool fails with insufficient permissions, restore the default scopes shown above and re-run `node auth.js both`.

## First-time setup or token recovery

If installing on a new machine, or if refresh tokens are deleted/invalidated, run:

```sh
cd /path/to/google-official-mcp-oauth
node auth.js gmail
node auth.js calendar
```

Or run both sequentially:

```cmd
node auth.js both
```

This opens a browser for Google consent, starts a temporary local callback server, uses `google-auth-library` to exchange the OAuth code for access/refresh tokens, and writes the token files expected by `bridge.js`.

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

