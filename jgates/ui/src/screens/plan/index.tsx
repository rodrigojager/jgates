import type { ScreenMeta } from "../../registry";
import ReviewScreen from "../validations-review";

// The review of the plan lives in Validações, Revisar (screens/validations-review). This route stays as an alias, so
// the address #/plan that earlier links, the run screen and the browser specs use keeps opening the same review.
// It belongs to the Validações area, so the breadcrumb has a title instead of an empty last item.
export const screen: ScreenMeta = { id: "plan", path: "/plan", area: "validations", order: 90 };

export default function PlanAlias() {
  return <ReviewScreen />;
}
