import { loadUserSettings, saveUserSettings } from "../utils/settings.js";
import { getProviderCapabilities } from "./capabilities.js";
import { setKeyForProvider } from "./keychain.js";
import type { ProviderId } from "./types.js";

export interface ProviderCredentials {
  apiKey: string;
  /** Omitted only after the user explicitly chooses a workspace-scoped key. */
  workspaceId?: string;
}

export function workspaceIdError(provider: ProviderId, value: string): string | null {
  const setup = getProviderCapabilities(provider).workspaceSetup();
  if (!setup) return null;
  const id = value.trim();
  if (!id) return "Workspace ID is required for a key that is not workspace-scoped.";
  if (!id.startsWith(setup.idPrefix) || !/^[a-zA-Z0-9]+$/.test(id.slice(setup.idPrefix.length))) {
    return `Workspace ID must start with ${setup.idPrefix} followed by letters or digits.`;
  }
  return null;
}

/** Shared interactive contract for `keys set` and the terminal config screen. */
export async function promptProviderCredentials(
  provider: ProviderId,
  prompt: (question: string) => Promise<string>,
): Promise<ProviderCredentials | null> {
  const apiKey = (await prompt(`Paste ${provider} API key (hidden): `)).trim();
  if (!apiKey) return null;
  if (apiKey.length < 20) throw new Error(`Key for '${provider}' is too short (< 20 chars).`);
  const setup = getProviderCapabilities(provider).workspaceSetup();
  if (!setup) return { apiKey };

  let scope: string;
  let scopeError = "";
  do {
    scope = (
      await prompt(`${scopeError}Key scope: [1] specific workspace, [2] not workspace-scoped / unsure [2]: `)
    ).trim();
    scopeError = "Choose 1 or 2. ";
  } while (scope !== "" && scope !== "1" && scope !== "2");
  if (scope === "1") return { apiKey };

  let error: string | null = null;
  for (;;) {
    const workspaceId = (await prompt(`${error ? `${error}\n` : ""}${setup.help}\nWorkspace ID: `)).trim();
    error = workspaceIdError(provider, workspaceId);
    if (!error) return { apiKey, workspaceId };
  }
}

/** Called only after all interactive fields are complete, before factory rewarm. */
export async function saveProviderCredentials(
  provider: ProviderId,
  credentials: ProviderCredentials,
): Promise<boolean> {
  const setup = getProviderCapabilities(provider).workspaceSetup();
  const workspaceId = credentials.workspaceId?.trim();
  if (setup && credentials.workspaceId !== undefined) {
    const error = workspaceIdError(provider, credentials.workspaceId);
    if (error) throw new Error(error);
  }
  const ok = await setKeyForProvider(provider, credentials.apiKey.trim());
  if (!ok) return false;
  if (setup) {
    const current = loadUserSettings();
    saveUserSettings({
      providers: {
        ...current.providers,
        [provider]: { ...current.providers?.[provider], workspaceId },
      },
    });
  }
  return true;
}
