import { fileURLToPath } from "node:url";

/** Pass a simulated machine's capacity to its CLI/server children, never to real-engine cases. */
export function fakeHostDiskEnv(env, mb = 100_000) {
  const preload = fileURLToPath(new URL("./fake-host-disk.cjs", import.meta.url)).replaceAll("\\", "/");
  return {
    ...env,
    JGATES_TEST_HOST_DISK_MB: String(mb),
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`,
  };
}
