// Whether ZAP is in the JGates tools image, and its version, from image.json (nothing starts; there is no ZAP image of
// the customer's any more: the scan runs in the same step container as every other tool).
import { probeScannerImage, type ScannerImageProbe } from "../container-scanner/image.js";

export type ZapProbe = ScannerImageProbe;

export function probeZap(env: NodeJS.ProcessEnv): ZapProbe {
  return probeScannerImage(env, "zap");
}
