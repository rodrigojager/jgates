import { mount } from "./app";

// The application lives in app/ (shell, navigation, states); screens are found by folder in screens/ (registry.ts).
mount(document.getElementById("root") as HTMLElement);
