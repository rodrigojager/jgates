import { t } from "../i18n";

/** Blocker codes that mean "nobody is set to do the Semantic review": the provider step of the setup resolves them. */
export const PROVIDER_BLOCKER_CODES: ReadonlySet<string> = new Set(["SEMANTIC_NOT_CONFIGURED"]);

/** The route of the provider step of the Semantic setup. */
export const PROVIDER_STEP_ROUTE = "#/semantic/setup?step=provider";

/**
 * The one action next to a "no provider" blocker, wherever a screen lists blockers: a link straight to the provider
 * step. Renders nothing for any other code, so a screen can put it after every blocker message.
 */
export function ProviderFixLink({ code }: { code: string }) {
  if (!PROVIDER_BLOCKER_CODES.has(code)) return null;
  return (
    <>
      {" "}
      <a href={PROVIDER_STEP_ROUTE} data-testid="provider-fix-link">
        {t("provider_fix_link")}
      </a>
    </>
  );
}
