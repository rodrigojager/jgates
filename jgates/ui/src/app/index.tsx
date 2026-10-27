import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { syncLocaleWithPreferences } from "../i18n/locale";
import { ToastProvider } from "../components/Toast";
import { ThemeProvider, applyCachedTheme } from "../theme/ThemeProvider";
import "../theme/theme.css";
import { App } from "./App";
import { ShellProvider } from "./shell-context";

/** Mounts the application: theme and toasts around the shell, and the shell around the screens found by folder. */
export function mount(element: HTMLElement): void {
  applyCachedTheme();
  void syncLocaleWithPreferences();
  createRoot(element).render(
    <StrictMode>
      <ToastProvider>
        <ThemeProvider>
          <ShellProvider>
            <App />
          </ShellProvider>
        </ThemeProvider>
      </ToastProvider>
    </StrictMode>,
  );
}
