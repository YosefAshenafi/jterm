import ReactDOM from "react-dom/client";
import { StoreProvider } from "./state/store";
import App from "./App";
import "./styles.css";

// Note: no React.StrictMode. The terminal manager keeps imperative xterm/PTY
// instances keyed by pane id; StrictMode's intentional double-mount in dev would
// spawn duplicate shells, so we opt out here.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StoreProvider>
    <App />
  </StoreProvider>
);
