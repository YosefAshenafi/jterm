import ReactDOM from "react-dom/client";
import { StoreProvider } from "./state/store";
import { PaneDndProvider } from "./state/paneDnd";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StoreProvider>
    <PaneDndProvider>
      <App />
    </PaneDndProvider>
  </StoreProvider>
);
