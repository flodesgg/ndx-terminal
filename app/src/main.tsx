import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootBoundary } from "./components/RootBoundary";
import { registerAllFunctions } from "./functions";
import "./styles.css";
import { startClientMigration } from "./core/clientmigrate";
import { startSecIndex } from "./core/secindex";
import { applyTokens } from "./theme/tokens";
import { installAsciiCopy } from "./lib/format";

applyTokens();
installAsciiCopy(); // copied numbers carry ASCII "-" (SPEC §4.2)

registerAllFunctions();
startSecIndex(); // local security index for the command line (SPEC §4.3 rule 6, §4.7)
startClientMigration(); // stored layout + recent tickers → canonical IDs as the index loads (§5)

const root = createRoot(document.getElementById("root")!);
const perf = import.meta.env.DEV ? new URLSearchParams(location.search).get("perf") : null;
if (perf === "grid") {
  // Perf smoke harnesses (dev builds only; tree-shaken from production).
  void import("./perf/PerfGrid").then(({ PerfGrid }) =>
    root.render(
      <StrictMode>
        <PerfGrid />
      </StrictMode>,
    ),
  );
} else if (perf === "stream") {
  void import("./perf/PerfStream").then(({ PerfStream }) =>
    root.render(
      <StrictMode>
        <PerfStream />
      </StrictMode>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <RootBoundary>
        <App />
      </RootBoundary>
    </StrictMode>,
  );
}
