import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./help.css";

export const screen: ScreenMeta = { id: "help", path: "/help", area: "help", order: 80, icon: "terminal" };

// The commands are catalog messages (help_cmd_*), so a test can check each one against the real command line.
const STEPS = ["init", "ui", "plan", "run"] as const;
const MORE = ["history", "baseline", "gc", "doctor", "no_cache", "waiver", "preserve"] as const;
const FAQ = ["profile", "architecture", "cache", "waiver", "governed"] as const;

function Command({ command }: { command: string }) {
  const toast = useToast();
  const copy = () => {
    const done = () => toast(t("help_copied"), "ok");
    const failed = () => toast(t("help_copy_failed"), "warn");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(command).then(done, failed);
    else failed();
  };
  return (
    <div className="command row between">
      <code>{command}</code>
      <button type="button" className="icon-btn" aria-label={t("help_copy", { command })} onClick={copy}>
        <Icon name="copy" />
      </button>
    </div>
  );
}

export default function HelpScreen() {
  return (
    <div className="stack">
      <div>
        <h1>{t("help_title")}</h1>
        <p>{t("help_lead")}</p>
      </div>

      <div className="help-grid">
        {STEPS.map((step, index) => (
          <section key={step} className="card flat stack" aria-labelledby={`help-step-${step}`}>
            <div className="eyebrow">{t("help_step", { number: `0${index + 1}` })}</div>
            <h2 id={`help-step-${step}`}>{t(`help_step_${step}_title`)}</h2>
            <p>{t(`help_step_${step}_text`)}</p>
            <Command command={t(`help_cmd_${step}`)} />
          </section>
        ))}
      </div>

      <section className="card flat stack" aria-labelledby="help-more">
        <h2 id="help-more">{t("help_more")}</h2>
        {MORE.map((id) => (
          <div key={id} className="stack help-more-item">
            <p>{t(`help_more_${id}`)}</p>
            <Command command={t(`help_cmd_${id}`)} />
          </div>
        ))}
      </section>

      <section className="card flat stack help-faq" aria-labelledby="help-faq">
        <h2 id="help-faq">{t("help_faq")}</h2>
        {FAQ.map((id) => (
          <details key={id}>
            <summary>{t(`help_faq_${id}_q`)}</summary>
            <p>{t(`help_faq_${id}_a`)}</p>
          </details>
        ))}
        <details>
          <summary>{t("help_keyboard_q")}</summary>
          <p>{t("help_keyboard_a")}</p>
        </details>
      </section>
    </div>
  );
}
