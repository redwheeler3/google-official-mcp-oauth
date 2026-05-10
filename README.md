# Google Official Gmail/Calendar MCP Bridges for Cline

This folder contains a self-contained setup for using Google's official Gmail and Google Calendar MCP servers from Cline.

## Why these bridges exist

`mcp-remote` was not reliable for this setup because OAuth callback/token handling was brittle under Cline, and passing `Authorization: Bearer <token>` through Windows shell arguments lost the token. These bridges avoid both issues by refreshing tokens directly and setting HTTP headers directly in Node.js.

The shell-argument token issue appears to be Windows-specific. Mac and Linux users may not need these bridges if `mcp-remote` works reliably for their Cline setup.

## Files

- `bridge.js` — unified launcher for the Gmail and Calendar bridge services
- `auth.js` — first-time OAuth bootstrap/recovery script
- `client-info.json` — tracked template for compact OAuth client credentials
- `client-info.local.json` — ignored local OAuth client id/secret used by the bridges
- `client_secret.local.json` — ignored original Google Desktop OAuth client credential file used by `auth.js`
- `client_secret.example.json` — tracked sanitized example of the Google credential file shape
- `oauth-scopes.example.json` — tracked example for selecting OAuth scope profiles
- `test-bridge.js` — local test harness for bridge validation

## Current Cline MCP settings

The Cline settings should point at the bridge scripts, for example:

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

If this folder is moved, update those paths.

## Token files used by the bridges

The bridges read and refresh tokens at these locations:

```text
Gmail:    %USERPROFILE%\.gmail-mcp\credentials.json
Calendar: %USERPROFILE%\.config\google-calendar-mcp\tokens.json
```

These files contain long-lived OAuth refresh tokens. Treat them like passwords.

## OAuth credential files

Real OAuth client secrets should live only in ignored local files:

```text
client-info.local.json
client_secret.local.json
oauth-scopes.local.json
```

`auth.js` looks for local files first, then falls back to the tracked templates. The bridge scripts use `client-info.local.json` first, then `client-info.json` only as a fallback. If a file still contains `YOUR_...` placeholders, the scripts fail fast instead of attempting OAuth with invalid credentials.

Example `client-info.local.json`:

```json
{
  "client_id": "YOUR_REAL_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_REAL_CLIENT_SECRET"
}
```

If real credentials were ever committed or pushed to a shared remote, rotate the OAuth client secret in Google Cloud Console.

## OAuth scopes

By default, `auth.js` uses a `fullTooling` scope profile to preserve the currently working Gmail label/search/draft operations and Calendar create/update behavior:

- Gmail: `gmail.modify`, `gmail.settings.basic`
- Calendar: `calendar`

For a narrower Google-documented baseline, copy `oauth-scopes.example.json` to `oauth-scopes.local.json` and change `profile` to `leastPrivilegeDocumented`, then re-run OAuth:

```cmd
copy oauth-scopes.example.json oauth-scopes.local.json
notepad oauth-scopes.local.json
node auth.js both
```

You can also set `GOOGLE_MCP_SCOPE_PROFILE=leastPrivilegeDocumented` for a one-off auth run. If a tool fails with insufficient permissions, switch back to `fullTooling` or define explicit `gmail` / `calendar` scope arrays in `oauth-scopes.local.json`.

## First-time setup or token recovery

If installing on a new machine, or if refresh tokens are deleted/invalidated, run:

```cmd
cd /d C:\path\to\google-official-mcp-oauth
node auth.js gmail
node auth.js calendar
```

Or run both sequentially:

```cmd
node auth.js both
```

This opens a browser for Google consent, starts a temporary local callback server, uses `google-auth-library` to exchange the OAuth code for access/refresh tokens, and writes the token files expected by the bridge scripts.

## Testing the bridges

Without using Cline, you can test the bridges with:

```cmd
node test-bridge.js bridge.js gmail
node test-bridge.js bridge.js calendar
```

Expected behavior:

- `initialize` returns `StatelessServer vESF`
- `tools/list` returns tools
- `resources/list` returns JSON-RPC `-32601 Method not found`, which is expected because Google's official servers are tools-only

