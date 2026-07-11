import React from "react";
import { createRoot } from "react-dom/client";
import "regen-ui/styles.css";
import "./styles.css";
import "./feedback.css";
import "./comparison.css";
import "./model-calls.css";
import "./timeline.css";
import "./detail-views.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
