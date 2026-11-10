// The script that refreshes one advisory database inside the tools image (python3 -c <script> <database>). It runs in a
// data container: the only container of the product that has a network next to the jgates-data volume mounted for
// writing. Each database is built beside the old one and swapped in only when complete, then its fetch time is written
// into /data/jgates-data.json, so a refresh that fails halfway never leaves a half-written database stamped as fresh.
export const UPDATE_SCRIPT = String.raw`
import concurrent.futures, datetime, gzip, json, os, shutil, subprocess, sys, tempfile, urllib.request

DATA = "/data"
STATUS = DATA + "/jgates-data.json"


def run(cmd, env=None, ok=(0,)):
    result = subprocess.run(cmd, env={**os.environ, **(env or {})})
    if result.returncode not in ok:
        sys.exit(result.returncode or 1)


def swap(new, final):
    old = final + ".old"
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(final):
        os.rename(final, old)
    os.rename(new, final)
    shutil.rmtree(old, ignore_errors=True)


def stamp(database, source):
    try:
        with open(STATUS) as f:
            doc = json.load(f)
    except Exception:
        doc = {"schemaVersion": 1, "databases": {}}
    doc.setdefault("databases", {})[database] = {
        "fetchedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
    }
    tmp = STATUS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
    os.replace(tmp, STATUS)


def trivy():
    new = DATA + "/trivy.new"
    shutil.rmtree(new, ignore_errors=True)
    run(["trivy", "image", "--download-db-only", "--cache-dir", new, "--no-progress", "--disable-telemetry", "--skip-version-check"])
    if not os.path.exists(new + "/db/trivy.db"):
        sys.exit("trivy did not write its database")
    swap(new, DATA + "/trivy")
    return "ghcr.io/aquasecurity/trivy-db"


def osv():
    sources = tempfile.mkdtemp()
    files = {
        "package-lock.json": json.dumps({"name": "x", "version": "1.0.0", "lockfileVersion": 3, "packages": {"": {"name": "x", "version": "1.0.0"}, "node_modules/minimist": {"version": "1.2.8"}}}),
        "requirements.txt": "requests==2.31.0\n",
        "go.mod": "module example.com/x\n\ngo 1.21\n\nrequire golang.org/x/text v0.3.7\n",
        "Cargo.lock": 'version = 3\n\n[[package]]\nname = "time"\nversion = "0.1.45"\n',
        "packages.lock.json": json.dumps({"version": 1, "dependencies": {"net8.0": {"Newtonsoft.Json": {"type": "Direct", "requested": "[13.0.1, )", "resolved": "13.0.1"}}}}),
    }
    for name, text in files.items():
        with open(os.path.join(sources, name), "w") as f:
            f.write(text)
    new = DATA + "/osv.new"
    shutil.rmtree(new, ignore_errors=True)
    os.makedirs(new)
    # Exit 1 means "vulnerabilities found" (the sample lockfiles have some on purpose): the databases were downloaded.
    run(["osv-scanner", "scan", "source", "--recursive", "--offline-vulnerabilities", "--download-offline-databases", "--format", "json", "--output-file", tempfile.mkdtemp() + "/osv.json", sources], env={"OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY": new}, ok=(0, 1))
    found = [n for _, _, names in os.walk(new) for n in names]
    if not found:
        sys.exit("osv-scanner did not download any database")
    swap(new, DATA + "/osv")
    return "https://osv-vulnerabilities.storage.googleapis.com"


def govulndb():
    base = "https://vuln.go.dev"
    new = DATA + "/govulndb.new"
    shutil.rmtree(new, ignore_errors=True)
    os.makedirs(new + "/index")
    os.makedirs(new + "/ID")

    def fetch(path, optional=False):
        try:
            with urllib.request.urlopen(base + "/" + path, timeout=120) as r:
                body = r.read()
        except Exception:
            if optional:
                return None
            raise
        with open(new + "/" + path, "wb") as f:
            f.write(body)
        return body

    for name in ("db", "modules", "vulns"):
        raw = fetch("index/%s.json" % name)
        # The same index, compressed, is what a file:// client reads first.
        with open(new + "/index/%s.json.gz" % name, "wb") as f:
            f.write(gzip.compress(raw))
    vulns = json.loads(open(new + "/index/vulns.json").read())
    ids = [v["id"] for v in vulns]
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(lambda i: fetch("ID/%s.json" % i), ids))
    fetch("ID/index.json", optional=True)
    swap(new, DATA + "/govulndb")
    return base


def rustsec():
    new = DATA + "/rustsec.new"
    shutil.rmtree(new, ignore_errors=True)
    run(["git", "clone", "--quiet", "--depth", "1", "https://github.com/RustSec/advisory-db.git", new])
    swap(new, DATA + "/rustsec")
    return "https://github.com/RustSec/advisory-db"


database = sys.argv[1]
source = {"trivy": trivy, "osv": osv, "govulndb": govulndb, "rustsec": rustsec}[database]()
stamp(database, source)
print("jgates-data: %s updated" % database)
`;
