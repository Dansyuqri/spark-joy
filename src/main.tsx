import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Home } from "./components/HomePage";
import "./styles.css";

// Each run's page is below /r/<repo>/<run>/; the root lists the runs.
const inRun = /\/r\/[^/]+\/[^/]+\/$/.test(location.pathname);
createRoot(document.getElementById("root")!).render(inRun ? <App /> : <Home />);
