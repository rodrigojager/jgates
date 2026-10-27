import { t } from "../i18n";

/** Unified diff with a sign column, so added and removed lines are not told apart by color alone. */
export function DiffView({ diff }: { diff: string }) {
  if (diff.trim() === "") return <p>{t("diff_none")}</p>;
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <div className="diff" role="group" aria-label={t("diff_label")} tabIndex={0}>
      {lines.map((line, index) => {
        let kind = "ctx";
        if (line.startsWith("@@")) kind = "hunk";
        else if (line.startsWith("---") || line.startsWith("+++")) kind = "meta";
        else if (line.startsWith("+")) kind = "add";
        else if (line.startsWith("-")) kind = "del";
        const sign = kind === "add" ? "+" : kind === "del" ? "-" : " ";
        const body = kind === "add" || kind === "del" ? line.slice(1) : line;
        return (
          <div key={index} className={`diff-line ${kind}`}>
            <span className="sign" aria-hidden="true">
              {sign}
            </span>
            <span>
              {kind === "add" ? <span className="sr-only">{t("diff_added")}: </span> : null}
              {kind === "del" ? <span className="sr-only">{t("diff_removed")}: </span> : null}
              {body === "" ? " " : body}
            </span>
          </div>
        );
      })}
    </div>
  );
}
