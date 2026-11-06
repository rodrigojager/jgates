import { useEffect, useId, useRef, useState } from "react";
import type { MascotDomain, MascotSnapshot } from "../../../src/core/mascots/index";
import type { MascotGallery } from "../mascots/actors/renderer";
import { Icon, type IconName } from "./icons";
import { t } from "../i18n";
import "./quality-mascots.css";

// A remounted historical view must not replay an already observed celebration.
const observed = new Map<string, string>();

// One gallery (one WebGL context, the six mascots already built) for the whole app: going from one screen to the next
// moves its canvas into the new strip and points each mascot at the new viewport, so the mascots are not rebuilt and
// redrawn from scratch at every step. While no strip shows it, it waits RELEASE_MS for the next screen (which may
// still be loading its data) and is then disposed, so no graphics context outlives the screens that use it. A second
// strip shown at the same time gets a gallery of its own, as before.
interface SharedGallery {
  gallery: MascotGallery;
  owner: symbol | null;
  release: ReturnType<typeof setTimeout> | null;
  onError: (() => void) | null;
}
let shared: SharedGallery | null = null;
const RELEASE_MS = 10_000;
const healthy = (g: MascotGallery) => !g.disposed && !g.contextLost;

function newCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "quality-mascots-canvas";
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}
const statusIcons: Record<string, IconName> = { waiting: "info", processing: "refresh", passed: "check", failed: "alert", incomplete: "info", blocked: "lock", error: "x", timeout: "alert", cancelled: "stop", finished: "check", disabled: "power", not_applicable: "info", invalid: "settings" };

export function QualityMascotStrip({ snapshot, onSelect }: { snapshot: MascotSnapshot | null | undefined; onSelect?: (domain: MascotDomain, ids: string[]) => void }) {
  const root = useRef<HTMLElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const gallery = useRef<MascotGallery | null>(null);
  const firstApply = useRef(true);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState<MascotDomain | null>(null);
  const id = useId();
  const identity = snapshot ? `${snapshot.context}:${snapshot.runId ?? snapshot.planHash ?? "unknown"}` : "";

  const hasSnapshot = snapshot !== null && snapshot !== undefined;

  useEffect(() => {
    if (!hasSnapshot || !slot.current || !root.current) return;
    const me = Symbol("strip");
    let disposed = false;
    let scene: MascotGallery | null = null;
    let isShared = false;
    let resize: ResizeObserver | null = null;
    let intersection: IntersectionObserver | null = null;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const invalidate = () => scene?.invalidate();
    const changeMotion = () => { scene?.setReducedMotion(motion.matches); invalidate(); };
    const fail = () => { if (!disposed) setFailure(true); };
    setReady(false);
    setFailure(false);
    void import("../mascots/actors/renderer.js").then(({ MascotGallery }) => {
      if (disposed || !slot.current || !root.current) return;
      try {
        // A shared gallery that lost its context (or was disposed) is replaced, never reused.
        if (shared && shared.owner === null && !healthy(shared.gallery)) {
          if (shared.release) clearTimeout(shared.release);
          shared.gallery.dispose();
          shared = null;
        }
        if (shared && shared.owner === null) {
          if (shared.release) clearTimeout(shared.release);
          shared.release = null;
          shared.owner = me;
          shared.onError = fail;
          scene = shared.gallery;
          isShared = true;
        } else if (!shared) {
          const created: SharedGallery = { gallery: null as unknown as MascotGallery, owner: me, release: null, onError: fail };
          created.gallery = new MascotGallery({ canvas: newCanvas(), reducedMotion: motion.matches, onError: () => created.onError?.() });
          shared = created;
          scene = created.gallery;
          isShared = true;
        } else {
          scene = new MascotGallery({ canvas: newCanvas(), reducedMotion: motion.matches, onError: fail });
        }
        slot.current.appendChild(scene.canvas);
        for (const d of latest.current!.domains) {
          const viewport = root.current.querySelector<HTMLElement>(`[data-viewport="${d.domain}"]`)!;
          if (scene.get(d.domain)) scene.bind(d.domain, viewport);
          else scene.add(d.domain, viewport, { status: d.status });
        }
        scene.setReducedMotion(motion.matches);
        scene.visible = true;
        gallery.current = scene; firstApply.current = true;
        resize = new ResizeObserver(invalidate); resize.observe(root.current);
        intersection = new IntersectionObserver(([entry]) => { if (scene) { scene.visible = entry?.isIntersecting ?? true; invalidate(); } });
        intersection.observe(root.current);
        motion.addEventListener("change", changeMotion);
        window.addEventListener("scroll", invalidate, true);
        invalidate();
        setReady(true);
      } catch {
        if (scene && !isShared) scene.dispose();
        if (isShared && shared?.owner === me) { shared.gallery.dispose(); shared = null; }
        scene = null; isShared = false;
        fail();
      }
    }).catch(fail);
    return () => {
      disposed = true; resize?.disconnect(); intersection?.disconnect();
      motion.removeEventListener("change", changeMotion); window.removeEventListener("scroll", invalidate, true);
      if (scene) {
        scene.canvas.remove();
        const current = shared;
        if (isShared && current && current.gallery === scene && current.owner === me) {
          // Kept for the next screen's strip; disposed if none takes it in time.
          scene.visible = false;
          current.owner = null;
          current.onError = null;
          current.release = setTimeout(() => {
            if (shared === current && current.owner === null) { current.gallery.dispose(); shared = null; }
          }, RELEASE_MS);
        } else if (!isShared) scene.dispose();
      }
      gallery.current = null;
    };
  }, [hasSnapshot, attempt]);

  // The canvas is not rendered by React (it moves between screens): hide it here when the animation failed.
  useEffect(() => {
    if (gallery.current) gallery.current.canvas.hidden = failure;
  }, [failure, ready]);

  // A new subject (another plan, the run id that became known) is a first application of statuses, not a rebuild.
  useEffect(() => {
    firstApply.current = true;
  }, [identity]);

  useEffect(() => {
    if (!snapshot || !ready || !gallery.current) return;
    for (const d of snapshot.domains) {
      const key = `${identity}:${d.domain}`;
      const previous = observed.get(key);
      gallery.current.get(d.domain)?.setStatus(d.status, {
        hasFindings: d.hasFindings || d.hasWarnings, progress: null,
        settled: firstApply.current && (snapshot.settled || previous === d.status),
      });
      observed.set(key, d.status);
    }
    firstApply.current = false;
    while (observed.size > 600) observed.delete(observed.keys().next().value!);
    gallery.current.invalidate();
  }, [snapshot, ready, identity]);

  if (!snapshot) return null;
  const announcement = snapshot.domains.map((d) => `${t(`mascot_domain_${d.domain}`)}: ${t(snapshot.context === "configuration" && d.status === "waiting" ? "mascot_enabled" : `mascot_status_${d.status}`)}${d.hasFindings ? `. ${t("mascot_partial_findings")}` : d.hasWarnings ? `. ${t("mascot_warnings")}` : ""}`).join(". ");
  return (
    <section ref={root} className="quality-mascots" aria-label={t(snapshot.context === "run" ? "mascot_run" : "mascot_configuration")} data-testid="quality-mascots" data-context={snapshot.context}>
      <div ref={slot} className="quality-mascots-canvas-slot" />
      <div className="quality-mascots-grid">
        {snapshot.domains.map((d) => (
          <div key={d.domain} className="quality-mascot" data-domain={d.domain} data-status={d.status} data-selection={d.selection}>
            <div className="quality-mascot-viewport" data-viewport={d.domain} aria-hidden="true" />
            <strong>{t(`mascot_domain_${d.domain}`)}</strong>
            <span className="quality-mascot-status" data-status={d.status}><Icon name={snapshot.context === "run" && d.status === "waiting" ? "hourglass" : (statusIcons[d.status] ?? "info")} /> {t(snapshot.context === "configuration" && d.status === "waiting" ? "mascot_enabled" : `mascot_status_${d.status}`)}</span>
            {(d.status === "processing" || d.status === "waiting") && (d.hasFindings || d.hasWarnings) ? <small>{t(d.hasFindings ? "mascot_partial_findings" : "mascot_warnings")}</small> : null}
            {d.progress ? <small>{t("mascot_checks", { completed: d.progress.completed, total: d.progress.total })}</small> : null}
            {d.excluded ? <small>{t("mascot_excluded", { count: d.excluded })}</small> : null}
            {d.runOnlyExcluded ? <small>{t("mascot_run_excluded", { count: d.runOnlyExcluded })}</small> : null}
            {d.coverageGap ? <small>{t("mascot_gap")}</small> : null}
            <button type="button" className="quality-mascot-details" aria-expanded={open === d.domain} aria-controls={`${id}-${d.domain}`} onClick={() => {
              setOpen(open === d.domain ? null : d.domain);
              onSelect?.(d.domain, d.checks.map((c) => c.id));
            }}>{t("mascot_details", { domain: t(`mascot_domain_${d.domain}`) })}</button>
          </div>
        ))}
      </div>
      {snapshot.domains.map((d) => open === d.domain ? <div key={d.domain} id={`${id}-${d.domain}`} className="quality-mascot-evidence">
        <strong>{t(`mascot_domain_${d.domain}`)}</strong>
        {d.checks.length ? <ul>{d.checks.map((c) => <li key={c.id}>{c.label} · {t(`mascot_status_${c.status}`)}{c.origin ? ` · ${c.origin}` : ""}<p className="small muted">{c.reason}</p></li>)}</ul> : <p>{t("mascot_evidence_unavailable")}</p>}
      </div> : null)}
      {snapshot.evidenceUnavailable ? <p className="small muted">{t("mascot_evidence_unavailable")}</p> : null}
      {snapshot.reduced ? <p className="small muted">{t("mascot_reduced")}</p> : null}
      {snapshot.cancelling ? <p role="status">{t("mascot_cancelling")}</p> : null}
      {failure ? <p className="small muted" role="status">{t("mascot_fallback")} <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>{t("mascot_retry")}</button></p> : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </section>
  );
}
