import { useEffect, useState } from "react";
import { ErrorNotice, Loading } from "../../components/common";
import type { ScreenMeta } from "../../registry";
import { fetchSetup, reopenSetup } from "./api";
import Wizard from "./Wizard";

// #/setup: "Refazer a configuração guiada" opens the wizard again with the current values. The overview shows the same
// wizard by itself until the setup ends (app/states.tsx).
export const screen: ScreenMeta = { id: "wizard", path: "/setup", area: "overview", order: 2 };

export default function WizardScreen() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    // A setup that already ended is opened again (step 1, every value kept); one in progress resumes where it was.
    fetchSetup()
      .then((view) => (view.setup.completed || !view.open ? reopenSetup() : view))
      .then(
        () => alive && setReady(true),
        (e) => alive && setError(e),
      );
    return () => {
      alive = false;
    };
  }, []);
  if (error) return <ErrorNotice error={error} />;
  if (!ready) return <Loading />;
  return <Wizard />;
}
