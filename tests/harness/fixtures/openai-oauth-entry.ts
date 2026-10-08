// Test-only bootstrap: real loopback callback and token exchange, no browser or
// remote authentication request. The real TUI still saves tokens and rebuilds
// its provider factory through the production sign-in handler.
import http from "node:http";
import { OpenAIOAuthProvider, openAIOAuth } from "../../../src/providers/auth/openai-oauth.js";

const tokenServer = http.createServer((req, res) => {
  if (req.url !== "/oauth/token") {
    res.writeHead(404).end();
    return;
  }
  const claims = Buffer.from(
    JSON.stringify({
      email: "oauth-fixture@example.test",
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
    }),
  ).toString("base64url");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      id_token: `fixture.${claims}.signature`,
      expires_in: 3600,
    }),
  );
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
const address = tokenServer.address();
if (!address || typeof address === "string") throw new Error("OAuth fixture token server did not bind");
const provider = new OpenAIOAuthProvider({
  issuer: `http://127.0.0.1:${address.port}`,
  openBrowserFn: (authorizeUrl) => {
    if (process.env.MUONROI_OAUTH_FIXTURE_CANCEL === "1") return;
    const authorize = new URL(authorizeUrl);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    void fetch(callback)
      .then((response) => {
        if (!response.ok) throw new Error(`OAuth fixture callback failed (${response.status})`);
      })
      .catch((err) => console.error(`[oauth-fixture] callback: ${err.message}`));
  },
});
openAIOAuth.login = provider.login.bind(provider);
await import("../../../src/index.js");
