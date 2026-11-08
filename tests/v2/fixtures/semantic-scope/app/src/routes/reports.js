import { legacyTotal } from "../legacy/old-helper.js";
import { formatMoney } from "../util/format.js";

export function report(orders) {
  return formatMoney(legacyTotal(orders));
}
