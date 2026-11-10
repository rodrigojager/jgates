// The script the CodeQL preparation container runs (python3 is in the tools image). It is the only code that touches the
// network for CodeQL: it downloads the bundle and the checksum file of the same release, refuses a bundle whose SHA-256
// does not match, unpacks it next to the status file inside the jgates-codeql volume and stamps the status. Nothing is
// ever left half way: the previous bundle is replaced only after the new one is complete and verified.
//
// Environment: JGATES_CODEQL_URL (the bundle), JGATES_CODEQL_CHECKSUM_URL (its checksum file: `<sha256>  <name>`),
// JGATES_CODEQL_TERMS_ACCEPTED_AT (the acceptance recorded on the host, copied into the status).
export const PREPARE_SCRIPT = String.raw`
import datetime, hashlib, json, os, shutil, subprocess, sys, tarfile, urllib.request

ROOT = "/codeql"
url = os.environ["JGATES_CODEQL_URL"]
sum_url = os.environ["JGATES_CODEQL_CHECKSUM_URL"]
accepted = os.environ.get("JGATES_CODEQL_TERMS_ACCEPTED_AT", "")
name = url.rsplit("/", 1)[-1]
work = os.path.join(ROOT, ".prepare")
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work)

def fetch(target, to_file):
    request = urllib.request.Request(target, headers={"User-Agent": "jgates-codeql-prepare"})
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request, timeout=120) as response, open(to_file, "wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
            size += len(chunk)
    return digest.hexdigest(), size

try:
    sum_file = os.path.join(work, "checksum.txt")
    fetch(sum_url, sum_file)
    expected = ""
    for line in open(sum_file, encoding="utf-8").read().splitlines():
        parts = line.split()
        if parts and len(parts[0]) == 64 and (len(parts) == 1 or parts[-1].lstrip("*") == name):
            expected = parts[0].lower()
            break
    if not expected:
        raise SystemExit("jgates-codeql: the checksum file of the release has no SHA-256 for " + name)
    bundle = os.path.join(work, name)
    actual, size = fetch(url, bundle)
    if actual != expected:
        raise SystemExit("jgates-codeql: checksum mismatch for " + name + " (expected " + expected + ", got " + actual + "); nothing was installed")
    target = os.path.join(work, "unpacked")
    os.makedirs(target)
    with tarfile.open(bundle, "r:gz") as archive:
        for member in archive.getmembers():
            resolved = os.path.realpath(os.path.join(target, member.name))
            if not (resolved == target or resolved.startswith(target + os.sep)):
                raise SystemExit("jgates-codeql: the bundle has a path outside its folder: " + member.name)
        try:
            archive.extractall(target, filter="data")
        except TypeError:
            archive.extractall(target)
    os.remove(bundle)
    unpacked = os.path.join(target, "codeql")
    if not os.path.isfile(os.path.join(unpacked, "codeql")):
        raise SystemExit("jgates-codeql: the bundle has no codeql/codeql executable")
    final = os.path.join(ROOT, "codeql")
    shutil.rmtree(final, ignore_errors=True)
    os.rename(unpacked, final)
    version = ""
    probe = subprocess.run([os.path.join(final, "codeql"), "version", "--format=terse"], capture_output=True, text=True, timeout=300)
    if probe.returncode == 0:
        version = probe.stdout.strip().splitlines()[0] if probe.stdout.strip() else ""
    status = {
        "schemaVersion": 1,
        "version": version,
        "sha256": actual,
        "bytes": size,
        "source": url,
        "termsAcceptedAt": accepted,
        "preparedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(os.path.join(ROOT, "jgates-codeql.json"), "w", encoding="utf-8") as out:
        json.dump(status, out, indent=2)
    print("jgates-codeql: " + name + " " + actual + " verified and installed")
finally:
    shutil.rmtree(work, ignore_errors=True)
`;
