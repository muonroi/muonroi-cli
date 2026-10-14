import { getConfiguredProviders } from "../../../../src/providers/keychain.js";
import { getDisabledProviders } from "../../../../src/utils/settings.js";

console.log(
  JSON.stringify({ configuredProviders: await getConfiguredProviders(), disabledProviders: getDisabledProviders() }),
);
