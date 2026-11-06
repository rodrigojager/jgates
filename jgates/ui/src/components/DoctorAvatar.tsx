import { useEffect, useRef, useState } from "react";
import type { DoctorState } from "../mascots/doctor/index.js";
import { Icon, type IconName } from "./icons";

// The Doctor of the prerequisites bar: the Three.js mascot (mascots/doctor), loaded on demand and mounted into its
// own slot. Only `data-state` drives it (the mascot observes the attribute), so a state change animates instead of
// remounting. Without WebGL, or when the graphics context is lost, the slot falls back to an icon.

const FALLBACK: Record<DoctorState, IconName> = { checking: "refresh", "needs-you": "tools", ok: "check", error: "alert" };

export function DoctorAvatar({ state }: { state: DoctorState }) {
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let mounted: { dispose(): void } | null = null;
    const fail = () => {
      mounted?.dispose();
      mounted = null;
      if (!disposed) setFailed(true);
    };
    void import("../mascots/doctor/index.js")
      .then(({ mountDoctor }) => {
        if (disposed || !host.current) return;
        try {
          mounted = mountDoctor(host.current, { onError: fail });
        } catch {
          fail();
        }
      })
      .catch(fail);
    return () => {
      disposed = true;
      mounted?.dispose();
    };
  }, []);

  return (
    <span ref={host} className={`prq-avatar${failed ? " fallback" : ""}`} data-mascot="doctor" data-state={state} aria-hidden="true">
      {failed ? <Icon name={FALLBACK[state]} /> : null}
    </span>
  );
}
