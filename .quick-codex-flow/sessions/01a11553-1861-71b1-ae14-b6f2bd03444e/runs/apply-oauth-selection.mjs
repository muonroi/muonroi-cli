import { readFileSync, writeFileSync } from "node:fs";

const path = "src/ui/use-app-logic.tsx";
let source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  const startProviderOAuth = useCallback(");
const end = source.indexOf("  const cancelProviderOAuth = useCallback(", start);
if (start < 0 || end < start) throw new Error("OAuth handler boundaries not found");
let handler = source.slice(start, end);
const replaceOnce = (from, to) => {
  if (handler.split(from).length !== 2) throw new Error(`OAuth edit context ambiguous: ${from}`);
  handler = handler.replace(from, to);
};
replaceOnce("async (provider: ProviderId) => {", "async (provider: ProviderId, activateAfterLogin = false) => {");
replaceOnce(
  "      oauthAbortRef.current = new AbortController();",
  "      const attempt = new AbortController();\n      oauthAbortRef.current = attempt;",
);
replaceOnce(
  "cfg.provider.login({ signal: oauthAbortRef.current?.signal })",
  "cfg.provider.login({ signal: attempt.signal })",
);
handler = handler.replaceAll(
  "if (oauthCancelRef.current) return;",
  "if (attempt.signal.aborted || oauthCancelRef.current) return;",
);
replaceOnce(
  "        await refreshProvidersWithKey();\n        setOAuthLogin(null);",
  '        await refreshProvidersWithKey();\n        if (attempt.signal.aborted || oauthCancelRef.current) return;\n        if (activateAfterLogin) setAsDefaultProvider(provider);\n        setOAuthLogin(null);\n        pushToast("info", activateAfterLogin\n          ? `Signed in to ${cfg.displayName}. Active model: ${agent.getModel()}.`\n          : `Signed in to ${cfg.displayName}. Select a model to use this provider.`);',
);
replaceOnce("    [refreshProvidersWithKey],", "    [refreshProvidersWithKey, setAsDefaultProvider, pushToast, agent],");
// Place the handler after its activation dependency, avoiding a render-time TDZ.
source = source.slice(0, start) + source.slice(end);
const insertion = source.indexOf("  const toggleModelDisabled = useCallback(");
if (insertion < 0) throw new Error("Provider activation insertion point missing");
source = source.slice(0, insertion) + handler + source.slice(insertion);
const oldBranch = "else if (oauthProviders.has(p)) void startProviderOAuth(p);";
if (source.split(oldBranch).length !== 2) throw new Error("OAuth activation branch ambiguous");
source = source.replace(oldBranch, "else if (oauthProviders.has(p)) void startProviderOAuth(p, true);");
// Preserve this file's original CRLF convention and all unrelated WIP.
writeFileSync(path, source.replace(/\r?\n/g, "\r\n"));
