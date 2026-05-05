import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

interface CliOAuthStorage {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

const storage = new Map<string, CliOAuthStorage>();

function getStore(serverId: string): CliOAuthStorage {
  let s = storage.get(serverId);
  if (!s) {
    s = {};
    storage.set(serverId, s);
  }
  return s;
}

export class CliOAuthProvider {
  private _codeVerifier = "";
  private serverId: string;
  private _redirectUrl: string;
  private onAuthUrl: (url: URL) => void;

  constructor(opts: {
    serverId: string;
    callbackPort: number;
    onAuthorizationUrl: (url: URL) => void;
  }) {
    this.serverId = opts.serverId;
    this._redirectUrl = `http://127.0.0.1:${opts.callbackPort}/callback`;
    this.onAuthUrl = opts.onAuthorizationUrl;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "muonroi-cli",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return getStore(this.serverId).clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    getStore(this.serverId).clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return getStore(this.serverId).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    getStore(this.serverId).tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    getStore(this.serverId).discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return getStore(this.serverId).discovery;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    const s = getStore(this.serverId);
    if (scope === "all" || scope === "tokens") s.tokens = undefined;
    if (scope === "all" || scope === "client") s.clientInfo = undefined;
    if (scope === "all" || scope === "discovery") s.discovery = undefined;
    if (scope === "all" || scope === "verifier") this._codeVerifier = "";
  }

  cleanup(): void {
    // noop — callback server is managed externally
  }
}

export async function createOAuthProviderWithCallback(opts: {
  serverId: string;
  onAuthorizationUrl: (url: URL) => void;
}): Promise<{ provider: CliOAuthProvider; close: () => void }> {
  const server = await startOAuthCallbackServer({
    onCode: () => {
      // SDK handles code exchange internally
    },
  });

  const provider = new CliOAuthProvider({
    serverId: opts.serverId,
    callbackPort: server.port,
    onAuthorizationUrl: opts.onAuthorizationUrl,
  });

  return {
    provider,
    close() {
      server.close();
      provider.cleanup();
    },
  };
}
