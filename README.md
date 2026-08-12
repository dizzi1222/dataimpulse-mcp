# DataImpulse MCP Proxy

Use DataImpulse residential proxy targeting from Claude Code or OpenCode without routing the rest of your system through a proxy. This educational MCP server provides bounded access to public HTTP(S) pages with best-effort SSRF safeguards.

> [!WARNING]
> Never configure `HTTP_PROXY` or `HTTPS_PROXY` globally. This server creates a DataImpulse `ProxyAgent` for each MCP request, so other terminals, editors, package managers, and MCP servers remain unaffected.

## Quick Start

**Prerequisites:** Node.js 22.19.0 or later and a DataImpulse account with a username and password.

```bash
git clone https://github.com/Gentleman-Programming/dataimpulse-mcp.git
cd dataimpulse-mcp
npm install
```

The server reads only `DI_USER` and `DI_PASS` at runtime. Copy `.env.example` for local reference if useful, but configure credentials in your MCP client rather than committing a `.env` file.

## Connect Clients

### Claude Code

Run this from the checked-out repository, replacing the placeholders and path:

```bash
claude mcp add di-proxy --scope user \
  --env DI_USER=your_dataimpulse_username \
  --env DI_PASS=your_dataimpulse_password \
  -- node /absolute/path/to/dataimpulse-mcp/index.js
```

`--scope user` makes the server available to your local Claude Code user. Claude Code stores this configuration, including the supplied credentials, in `~/.claude.json`; protect that file and never commit or share it.

### OpenCode

Add this entry to your OpenCode configuration, replacing the placeholders and absolute path:

```json
{
  "mcp": {
    "di-proxy": {
      "type": "local",
      "command": ["node", "/absolute/path/to/dataimpulse-mcp/index.js"],
      "environment": {
        "DI_USER": "your_dataimpulse_username",
        "DI_PASS": "your_dataimpulse_password"
      }
    }
  }
}
```

Restart OpenCode after saving the configuration so it starts the stdio server with the new environment.

## Tool Reference

### `fetch_page`

Fetches a public HTTP(S) page through DataImpulse. By default, it returns cleaned, readable text; set `raw` to `true` when the caller needs HTML.

| Parameter | Required | Description |
| --- | --- | --- |
| `url` | Yes | Public HTTP(S) URL, up to 2,048 characters. URLs with credentials and local/private destinations are rejected. |
| `country` | No | Two-letter ISO country code, such as `US` or `ES`. |
| `city` | No | City token using letters, numbers, hyphens, or underscores. Requires `country`. |
| `session` | No | Stable session token using letters, numbers, hyphens, or underscores. |
| `raw` | No | Set to `true` to return HTML instead of cleaned text. |

```json
{
  "url": "https://example.com",
  "country": "US",
  "session": "research-001"
}
```

```json
{
  "url": "https://example.com",
  "country": "ES",
  "city": "Madrid",
  "raw": true
}
```

### `check_exit_ip`

Checks the public exit IP selected by DataImpulse without fetching a target page. Use it to verify country or session targeting before a workflow.

| Parameter | Required | Description |
| --- | --- | --- |
| `country` | No | Two-letter ISO country code. |
| `session` | No | Session token to check a stable route. |

```json
{
  "country": "US",
  "session": "research-001"
}
```

## Targeting And Errors

**Targeting practices**

- Use an explicit `country` for geo-specific content.
- Reuse the same `session` across multi-step flows that need a consistent route.
- Use `city` only when necessary: DataImpulse charges city targeting at double the normal rate.
- Avoid blind retries. Change one variable, observe the result, and stop when the target rejects the request.

**Error actions**

| Response | Meaning | Action |
| --- | --- | --- |
| `407 TRAFFIC_EXHAUSTED` | DataImpulse traffic credit is exhausted. | Add traffic credit, then retry. |
| `407 THREADS_EXHAUSTED` | The account has more than 2,000 active connections. | Reduce concurrent requests, then retry. |
| `503 NO_RAY` | No proxy IP matches the requested targeting. | Remove city targeting and retain only the country. |
| `403` | The destination blocked the request. | Try another country or a fixed session once; respect the site's rules. |
| `429` | The destination applied rate limiting or anti-bot controls. | Try one new session or another country once. If it persists, access the target site directly or use another search engine. Do not retry blindly. |

## Security Model

- **Best-effort SSRF safeguards:** every initial URL and redirect target is checked for an HTTP(S) scheme, no credentials, a permitted hostname, and public-only local DNS resolution. Local, private, metadata, credentialed, and mixed-resolution hosts are rejected, with a maximum of 10 redirects.
- **Remote proxy resolution:** `ProxyAgent` sends the hostname to the remote proxy, which performs its own DNS resolution. DNS rebinding or split-horizon DNS can therefore differ from local validation. Do not use this tool with untrusted URLs in high-security environments; if exposing it to untrusted users, prefer a domain allowlist.
- **Credentials:** `DI_USER` and `DI_PASS` are read only at startup and are never logged or returned to MCP clients.
- **Response bounds:** bodies with an advertised `Content-Length` above 1,048,576 bytes (1 MiB) are rejected before reading; streaming bodies are cancelled once they exceed that limit. Successful and error output is then limited to 60,000 characters.
- **Timeout:** every request has a 45-second timeout; each per-request proxy agent is destroyed after use.

## License

This project is licensed under the [MIT License](LICENSE).
