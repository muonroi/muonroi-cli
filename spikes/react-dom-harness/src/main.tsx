import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRegistry } from "./registry";
import { RegistryCtx, Semantic } from "./semantic";
import { startSnapshotLoop } from "./snapshot-loop";

const registry = createRegistry();

function App() {
  const [show, setShow] = useState(true);
  // Auto-toggle: mount → 800ms → unmount (drives the assert server test)
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <RegistryCtx.Provider value={registry}>
      {show && (
        <Semantic id="btn" role="button" name="Click">
          Click
        </Semantic>
      )}
      <button type="button" onClick={() => setShow((s) => !s)}>
        Toggle
      </button>
    </RegistryCtx.Provider>
  );
}

startSnapshotLoop(registry);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
