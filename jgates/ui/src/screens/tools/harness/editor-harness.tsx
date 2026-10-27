import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "../../../components/Editor";

// Test harness for the Editor component (tests/ui/tools.spec.ts builds and serves this page on its own; the application
// never loads it: it is not a screen folder). The parent hands the text back after a delay, the way a slow render does,
// so a render with an older text arrives while the user has already typed more.

function Harness() {
  const [value, setValue] = useState("");
  const [reported, setReported] = useState<string[]>([]);
  return (
    <div>
      <Editor
        value={value}
        format="text"
        readOnly={false}
        label="harness"
        onChange={(text) => {
          setReported((r) => [...r, text]);
          // The parent re-renders with this text 150 ms later, whatever was typed meanwhile.
          setTimeout(() => setValue(text), 150);
        }}
      />
      <button type="button" onClick={() => setValue("replaced from outside")}>
        replace
      </button>
      <output data-testid="parent-value">{value}</output>
      <output data-testid="reported-count">{reported.length}</output>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
