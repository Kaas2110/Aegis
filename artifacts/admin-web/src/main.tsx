import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Set dark mode explicitly since it's a dark tool by default
document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(<App />);
