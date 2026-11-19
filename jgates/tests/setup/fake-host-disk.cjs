// Test-only host capacity for subprocesses of fake-machine acceptance cases. The production disk calculation and
// guard still run; only the operating-system measurement is supplied by the simulated machine.
const fs = require("node:fs");
const mb = Number(process.env.JGATES_TEST_HOST_DISK_MB);
if (!Number.isSafeInteger(mb) || mb < 0) throw new Error("A fake host disk capacity in MB is required");
const stats = { bavail: mb * 256, bsize: 4096 };
fs.statfsSync = () => ({ ...stats });
fs.promises.statfs = async () => ({ ...stats });
