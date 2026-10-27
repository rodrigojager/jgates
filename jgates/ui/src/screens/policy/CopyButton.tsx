import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";

/** A button that copies `text` to the clipboard and says so; `label` is its accessible name. */
export function CopyButton({ text, label, testid }: { text: string; label: string; testid: string }) {
  const toast = useToast();
  const copy = () => {
    const done = () => toast(t("pol_copied"), "ok");
    const failed = () => toast(t("pol_copy_failed"), "warn");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, failed);
    else failed();
  };
  return (
    <button type="button" className="btn" aria-label={label} data-testid={testid} onClick={copy}>
      <Icon name="copy" />
      {t("pol_copy")}
    </button>
  );
}
