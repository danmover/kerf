# ChatGPT and OpenAI

Kerf supports two separate connections. Neither replaces or uses your other provider's credentials.

## OpenAI models inside Kerf (web and desktop)

1. Open **Settings → AI → OpenAI API key**.
2. Add a key from <https://platform.openai.com/api-keys>. Choose whether to remember it on this device; remembered keys are encrypted in a separate IndexedDB vault record.
3. Select GPT-6.1 Sol, GPT-6 Astra or GPT-6 Luna. Chat, image/PDF attachments, design tools, self-review and subassembly agents use the selected provider.

Requests use the Responses API directly at `https://api.openai.com/v1/responses`, with `store: false`. OpenAI API billing is separate from a ChatGPT subscription. Selecting Claude continues to use the existing Claude browser/account/shared-key routing. Anthropic-specific quick routing and cache keep-warm requests are disabled for OpenAI; OpenAI uses its own prompt caching. Model prices are estimates based on standard pricing checked on 21 October 2026.

## Control Kerf from ChatGPT (hosted web app)

The hosted Kerf server exposes authenticated Streamable HTTP MCP at **`https://YOUR_KERF_HOST/mcp`**. The CAD engine runs in your explicitly connected browser tab. Keep that tab open; nothing runs against an arbitrary account or device. The desktop app's loopback MCP endpoint is for local clients, and cannot be reached directly by ChatGPT's remote servers.

### Server configuration

Configure a pre-registered OAuth client on the same HTTPS Kerf server:

```text
KERF_CHATGPT_CLIENT_ID=kerf-chatgpt
KERF_CHATGPT_CLIENT_SECRET=<at least 32 random characters>
KERF_CHATGPT_REDIRECT_URIS=<exact callback URI shown by ChatGPT>
```

Generate a secret with `npm run server:secret`. Do not commit it. Set `KERF_ORIGIN` to the public HTTPS origin as usual. The existing Docker/Fly deployment runs both the web app and these endpoints. A static-only host cannot provide remote MCP.

The authorization server advertises RFC 9207 issuer identification, so ChatGPT can use its stable redirect URI `https://chatgpt.com/connector_platform_oauth_redirect`. Copy the actual URI shown in ChatGPT's connection management page into the allowlist; there is no wildcard matching. Multiple exact URIs can be comma-separated.

### Connect

1. Sign in to your hosted Kerf account and open a project.
2. In **Settings → AI → ChatGPT MCP connection**, click **Connect this tab**.
3. In ChatGPT's developer settings, create a custom MCP connection using your `/mcp` URL, OAuth, and the client ID and secret configured above.
4. Approve access to your Kerf account. If the authorization page asks you to sign in, open Kerf in the linked tab, sign in, and reload the authorization page.
5. Ask ChatGPT: “Read Kerf's instructions, inspect my design and help me improve it.”

Availability of custom MCP connections depends on ChatGPT's plan and workspace settings. No public directory listing or automatic installation is performed by this code.

Disconnecting the tab ends pending calls. **Revoke access** removes the grant and its tokens. Closing the tab drops the connection; if the browser cannot deliver its disconnect request, the server expires its lease after one minute. Signing out aborts local calls. Only one tab per account can own the connection at once.

### Protocol and security

- OAuth authorization code with S256 PKCE, explicit consent bound to the browser session, one-use 60-second codes, opaque hashed access tokens, and rotating refresh tokens when `offline_access` is requested.
- Resource/audience binding to the exact `/mcp` URL; issuer, resource, client, expiry, disabled-account and tool-scope checks on each authenticated request. Scopes: `kerf:read`, `kerf:write`, `offline_access`.
- OAuth discovery at `/.well-known/oauth-authorization-server` and protected-resource discovery at `/.well-known/oauth-protected-resource/mcp`.
- MCP protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. Stateless JSON POST responses; GET/DELETE return 405. Unsupported methods and malformed/batched JSON-RPC requests are rejected.
- The browser relay uses the existing HttpOnly account cookie, same-origin checks and `x-kerf` CSRF header. Each connection is bound to a user and browser session; calls never fall through to another user's tab.
- CAD calls use the same tool executor, edit queue, checks and undo/version history as Kerf's local MCP client. Kerf's own chat must finish before an external client can edit. ChatGPT asks its own questions; chat-only reviewer and subassembly tools are not exported over MCP.
- Use a single server process, as with the existing SQLite-backed app. Live relay queues and in-progress consent pages are in memory; restarting the process disconnects tabs. Grants survive restarts in SQLite.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Responses API](https://developers.openai.com/api/docs/guides/responses), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [pricing](https://developers.openai.com/api/docs/pricing).
