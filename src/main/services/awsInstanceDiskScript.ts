// The one program the desktop runs on the AWS instance to measure, clean and
// browse its disk. It runs as the instance user over SSH (`python3 -` with
// this text on stdin) and prints one JSON document. The request travels
// inside the text, never on the command line, so its size has no limit there.
//
// Safety is decided here, on the machine, at the moment of the change, never
// from a listing the desktop read earlier: a path is only removed when it is
// inside one of the places the app owns and may rebuild, nothing running
// uses it or works around it, it is not the program version in use or one
// being installed, and it holds or sits in no git project a member could lose
// work in (a linked worktree, uncommitted or unpushed changes, a stash).

import { AWS_DISK_JOURNAL_KEEP_BYTES } from "../../shared/cloudRuns";

export interface AwsInstanceDiskRequest {
  mode: "report" | "clean" | "list" | "delete";
  /** This desktop's program folder and its data folder on the instance. */
  root: string;
  data: string;
  arg?: unknown;
}

/** Most entries a listing returns, largest first. */
export const AWS_DISK_LIST_LIMIT = 300;

export function awsInstanceDiskScript(request: AwsInstanceDiskRequest): string {
  // A JSON string literal is a valid Python string literal.
  return `import json\nPAYLOAD = json.loads(${JSON.stringify(JSON.stringify(request))})\n${SCRIPT}`;
}

const SCRIPT = String.raw`
import hashlib, os, re, shutil, subprocess, sys, tempfile, time

LIST_LIMIT = ${AWS_DISK_LIST_LIMIT}
JOURNAL_KEEP_BYTES = ${AWS_DISK_JOURNAL_KEEP_BYTES}
HOME = os.path.realpath(os.path.expanduser("~"))
MODE = PAYLOAD.get("mode")
ARG = PAYLOAD.get("arg")

def real(path):
    return os.path.realpath(path)

def inside(path, parent):
    return path == parent or path.startswith(parent + "/")

def home_path(raw):
    if not isinstance(raw, str) or not raw:
        return None
    if raw.startswith("~/"):
        raw = os.path.join(HOME, raw[2:])
    if not raw.startswith("/"):
        return None
    p = real(raw)
    return p if inside(p, HOME) and p != HOME else None

OWN = home_path(PAYLOAD.get("root"))
OWN_DATA = home_path(PAYLOAD.get("data"))
if not OWN or not OWN_DATA:
    print(json.dumps({"ok": False, "error": "bad program folder"})); sys.exit(0)

# A full pass over a small instance's disk takes a while and must not slow
# the agents working on it; children (du, git) inherit both priorities.
try:
    os.nice(19)
except OSError:
    pass
if shutil.which("ionice"):
    subprocess.run(["ionice", "-c", "3", "-p", str(os.getpid())], capture_output=True)

DOT = os.path.join(HOME, ".accordagents")
LOGS = os.path.join(OWN_DATA, "debug-logs")
RELEASES = os.path.join(OWN, "releases")
MIRRORS = os.path.join(OWN, "workspace", "mirrors")
RUNS = os.path.join(DOT, "remote-runs")
DEVICES = os.path.join(RUNS, "devices")
LITERAL_TILDE = os.path.join(HOME, "~")
DAY = 86400
LOG_KEEP_SECONDS = DAY
# A version staged this recently may be an update being installed.
RELEASE_GRACE_SECONDS = 3600
CACHE_DIRS = [os.path.join(HOME, ".npm"), os.path.join(HOME, ".cache"),
              os.path.join(OWN, "home", ".npm"), os.path.join(OWN, "home", ".cache")]
QA_BROWSERS = [os.path.join(c, "ms-playwright") for c in CACHE_DIRS]
# Sign-ins that live in a cache folder.
CACHE_SIGN_INS = [os.path.join(c, "huggingface", name) for c in CACHE_DIRS for name in ("token", "stored_tokens")]
PROGRAM_ROOT = re.compile(r"accordagents-(?:[0-9a-f]{24}|machine)")
PROC = os.environ.get("ACCORDAGENTS_DISK_PROC", "/proc")
UNIT_DIRS = ["/etc/systemd/system", os.path.join(HOME, ".config/systemd/user")]
GIT_ENV = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
SIZE_CACHE = os.path.join(tempfile.gettempdir(), "accordagents-disk-sizes-" + hashlib.sha256(os.fsencode(OWN)).hexdigest()[:16] + ".json")
SIZE_CACHE_SECONDS = 600

def depth(path, parent):
    return 0 if path == parent else path[len(parent):].count("/")

def location(path):
    """The entry a path names: its folder resolved, its own name kept, so a
    link is judged and removed where it is, never where it points."""
    path = os.path.abspath(path)
    return os.path.join(real(os.path.dirname(path)), os.path.basename(path))

def space():
    st = os.statvfs("/")
    return {"totalBytes": st.f_blocks * st.f_frsize, "usedBytes": (st.f_blocks - st.f_bfree) * st.f_frsize,
            "availableBytes": st.f_bavail * st.f_frsize}

def du_lines(args, paths):
    out = []
    for start in range(0, len(paths), 500):
        out += subprocess.run(["du"] + args + ["--"] + paths[start:start + 500],
                              capture_output=True, text=True, errors="surrogateescape").stdout.splitlines()
    return out

def parse_du(lines):
    sizes = {}
    for line in lines:
        parts = line.split("\t", 1)
        if len(parts) == 2 and parts[0].isdigit():
            sizes[parts[1]] = int(parts[0]) * 1024
    return sizes

def du(paths):
    paths = [p for p in paths if os.path.lexists(p)]
    return sum(parse_du(du_lines(["-s", "-k", "-x"], paths)).values()) if paths else 0

# Sizes from one pass over the home folder: measured by the report and kept
# for a while, so listings and clean-ups right after it do not walk again.
SIZES = {}
def load_sizes():
    global SIZES
    try:
        with open(SIZE_CACHE) as handle:
            saved = json.load(handle)
        if time.time() - saved.get("at", 0) < SIZE_CACHE_SECONDS:
            SIZES = saved.get("sizes", {})
    except (OSError, ValueError):
        SIZES = {}

def save_sizes(at=None):
    try:
        if at is None:
            with open(SIZE_CACHE) as handle:
                at = json.load(handle).get("at", 0)
        tmp = SIZE_CACHE + ".tmp"
        with open(tmp, "w") as handle:
            json.dump({"at": at, "sizes": SIZES}, handle)
        os.replace(tmp, SIZE_CACHE)
    except (OSError, ValueError):
        forget_sizes()

def forget_sizes():
    try:
        os.remove(SIZE_CACHE)
    except OSError:
        pass

def size(path):
    return SIZES[path] if path in SIZES else measure(path)

def measure(path):
    if not os.path.lexists(path):
        return 0
    if os.path.isdir(path) and not os.path.islink(path):
        return du([path])
    try:
        return os.lstat(path).st_blocks * 512
    except OSError:
        return 0

def total(paths):
    return sum(size(p) for p in paths)

def used_paths():
    used = set()
    def add(target):
        target = target.replace(" (deleted)", "")
        if inside(target, HOME):
            used.add(real(target))
    try:
        pids = [p for p in os.listdir(PROC) if p.isdigit() and int(p) != os.getpid()]
    except OSError:
        pids = []
    for pid in pids:
        base = os.path.join(PROC, pid)
        for link in ("cwd", "exe"):
            try:
                add(os.readlink(os.path.join(base, link)))
            except OSError:
                pass
        try:
            for fd in os.listdir(os.path.join(base, "fd")):
                try:
                    add(os.readlink(os.path.join(base, "fd", fd)))
                except OSError:
                    pass
        except OSError:
            pass
        try:
            with open(os.path.join(base, "cmdline"), "rb") as handle:
                for raw in handle.read().split(b"\0"):
                    arg = os.fsdecode(raw)
                    if arg.startswith(HOME + "/"):
                        add(arg)
        except OSError:
            pass
    for folder in UNIT_DIRS:
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if not name.endswith(".service"):
                continue
            try:
                with open(os.path.join(folder, name), errors="replace") as handle:
                    text = handle.read()
            except OSError:
                continue
            for match in re.findall(r"(" + re.escape(HOME) + r"/[^\s\"'=:;]+)", text):
                add(match)
    return used

USED = None
USED_AT = 0
def used():
    global USED, USED_AT
    if USED is None or time.time() - USED_AT > 2:
        USED = used_paths()
        USED_AT = time.time()
    return USED

OTHER_ROOTS = None
def other_roots():
    """Program folders of other computers sharing the instance."""
    global OTHER_ROOTS
    if OTHER_ROOTS is None:
        OTHER_ROOTS = []
        for name in sorted(os.listdir(HOME)):
            p = os.path.join(HOME, name)
            if p == OWN or not PROGRAM_ROOT.fullmatch(name) or os.path.islink(p) or not os.path.isdir(p):
                continue
            if os.path.isdir(os.path.join(p, "releases")) or os.path.islink(os.path.join(p, "current")):
                OTHER_ROOTS.append(p)
    return OTHER_ROOTS

def program_data_for(root):
    name = os.path.basename(root)
    return os.path.join(DOT, "machine" if name == "accordagents-machine" else name)

def owned(p):
    """A place the app made and may rebuild, as opposed to what holds it."""
    return (
        os.path.dirname(p) == RELEASES
        or inside(p, LOGS) and p != LOGS
        or any(inside(p, c) and p != c for c in CACHE_DIRS)
        or inside(p, MIRRORS) and p != MIRRORS
        or inside(p, DEVICES) and depth(p, DEVICES) >= 2
        or inside(p, LITERAL_TILDE) and p != LITERAL_TILDE
        or any(inside(p, r) or inside(p, program_data_for(r)) for r in other_roots())
    )

def in_use(p):
    """Something running uses the path, something below it, or works in a
    folder around it that the app could remove as a whole."""
    for u in used():
        if inside(u, p) or inside(p, u) and u != p and owned(u):
            return True
    return False

def kept_releases():
    keep = set()
    for link in ("current", "current.pending"):
        p = os.path.join(OWN, link)
        if os.path.islink(p):
            keep.add(real(p))
    return keep

def recent(p):
    try:
        return time.time() - os.lstat(p).st_mtime < RELEASE_GRACE_SECONDS
    except OSError:
        return False

def git(top, *args):
    try:
        return subprocess.run(["git", "-C", top] + list(args), capture_output=True, text=True, env=GIT_ENV)
    except OSError:
        return None

def repo_hazard(top, linked, bare):
    """Why a git project may hold work a member would lose; None if none."""
    if linked:
        return "worktree"
    listing = git(top, "worktree", "list", "--porcelain")
    if listing is None or listing.returncode != 0:
        return "changes"
    if listing.stdout.count("worktree ") > 1:
        return "worktree"
    if not bare:
        status = git(top, "status", "--porcelain", "--untracked-files=normal")
        if status is None or status.returncode != 0 or status.stdout.strip():
            return "changes"
    stash = git(top, "stash", "list")
    if stash is None or stash.returncode != 0 or stash.stdout.strip():
        return "changes"
    ahead = git(top, "log", "--branches", "--not", "--remotes", "--format=%H", "-1")
    if ahead is None or ahead.returncode != 0 or ahead.stdout.strip():
        return "unpushed"
    return None

def submodule(dot_git):
    """A submodule's .git file: its changes show in the project around it."""
    try:
        with open(dot_git, errors="replace") as handle:
            return "/modules/" in handle.read(4096)
    except OSError:
        return False

def is_bare(folder, dirs, files):
    return "HEAD" in files and "objects" in dirs and "refs" in dirs

def repository_around(p):
    """A path inside a git project or its .git folder: a member's work, never
    removed piece by piece. The whole project may go when it is safe."""
    if os.path.basename(p) == ".git":
        return "repository"
    current = os.path.dirname(p)
    while inside(current, HOME) and current != HOME:
        if os.path.basename(current) == ".git" or os.path.lexists(os.path.join(current, ".git")):
            return "repository"
        try:
            names = set(os.listdir(current))
        except OSError:
            names = set()
        if "HEAD" in names and "objects" in names and "refs" in names:
            return "repository"
        current = os.path.dirname(current)
    return None

def repositories_below(path):
    """Every git project in a folder, at any depth."""
    if not os.path.isdir(path) or os.path.islink(path):
        return None
    for top, dirs, files in os.walk(path):
        if ".git" in dirs or ".git" in files and not submodule(os.path.join(top, ".git")):
            hazard = repo_hazard(top, ".git" in files, False)
            if hazard:
                return hazard
        elif is_bare(top, dirs, files):
            hazard = repo_hazard(top, False, True)
            if hazard:
                return hazard
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
    return None

def lock_reason(path):
    """None when the path may be removed; otherwise why it may not."""
    p = location(path)
    if not inside(p, HOME) or p == HOME:
        return "system"
    if not owned(p):
        if inside(p, os.path.join(OWN, "home")):
            return "sign-ins"
        if inside(p, os.path.join(OWN, "agent-setup")) or inside(p, os.path.join(RUNS, "agent-setup")):
            return "agent-tools"
        if inside(p, OWN) or inside(p, OWN_DATA):
            return "program"
        return "system"
    if os.path.dirname(p) == RELEASES and real(p) in kept_releases():
        return "running-version"
    if any(inside(c, p) for c in CACHE_DIRS) and p not in CACHE_DIRS:
        return "system"
    if any(inside(p, b) for b in QA_BROWSERS):
        return "qa-browser"
    if any(inside(s, p) for s in CACHE_SIGN_INS if os.path.lexists(s)):
        return "sign-ins"
    if inside(p, DEVICES) and "agent-setup" in p[len(DEVICES):].split("/"):
        return "agent-tools"
    for root in other_roots():
        if (inside(p, root) or inside(p, program_data_for(root))) and in_use(root):
            return "other-program"
    if in_use(p) or os.path.dirname(p) == RELEASES and recent(p):
        return "in-use"
    return repository_around(p) or repositories_below(p)

def role_of(p):
    if p == OWN:
        return "program"
    if p in other_roots():
        return "other-program" if in_use(p) else "idle-program"
    if p == DOT or p == OWN_DATA:
        return "program-data"
    if p == RUNS:
        return "cloud-runs"
    if p == MIRRORS or p == os.path.join(OWN, "workspace"):
        return "project-copies"
    if p == RELEASES:
        return "versions"
    if os.path.basename(p) == "agent-setup":
        return "agent-tools"
    if p == os.path.join(OWN, "home"):
        return "sign-ins"
    if p == LOGS:
        return "logs"
    if p in CACHE_DIRS:
        return "cache"
    if p == LITERAL_TILDE:
        return "mailbox-runners"
    return None

def releases():
    keep = kept_releases()
    items = []
    if os.path.isdir(RELEASES):
        for name in sorted(os.listdir(RELEASES)):
            p = os.path.join(RELEASES, name)
            items.append((p, real(p) in keep or recent(p) or in_use(p)))
    return items

def old_logs():
    now = time.time()
    items = []
    if os.path.isdir(LOGS):
        for name in sorted(os.listdir(LOGS)):
            p = os.path.join(LOGS, name)
            try:
                if os.path.isfile(p) and now - os.path.getmtime(p) > LOG_KEEP_SECONDS:
                    items.append(p)
            except OSError:
                pass
    return items

def cache_entries():
    """What the cache clean-up removes: everything in the caches but the
    browser for QA and sign-ins kept there."""
    items = []
    def collect(folder):
        for name in os.listdir(folder):
            p = os.path.join(folder, name)
            if any(inside(p, b) for b in QA_BROWSERS) or p in CACHE_SIGN_INS or in_use(p):
                continue
            if os.path.isdir(p) and not os.path.islink(p) and any(inside(s, p) for s in CACHE_SIGN_INS if os.path.lexists(s)):
                collect(p)
                continue
            items.append(p)
    for c in CACHE_DIRS:
        if os.path.isdir(c):
            collect(c)
    return items

def journal_bytes():
    return du(["/var/log/journal"])

def report():
    global SIZES
    forget_sizes()
    SIZES = parse_du(subprocess.run(["du", "-k", "-x", "-d", "5", HOME], capture_output=True, text=True,
                                    errors="surrogateescape").stdout.splitlines())
    at = time.time()
    rels = releases()
    logs_total = size(LOGS)
    caches = [c for c in CACHE_DIRS if os.path.isdir(c)]
    others = other_roots()
    other_paths = others + [program_data_for(r) for r in others]
    agent_paths = [os.path.join(OWN, "agent-setup"), os.path.join(RUNS, "agent-setup")]
    if os.path.isdir(DEVICES):
        for device in os.listdir(DEVICES):
            agent_paths.append(os.path.join(DEVICES, device, "agent-setup"))
    agent = total(agent_paths)
    runs = max(0, total([RUNS, LITERAL_TILDE]) - total([p for p in agent_paths if inside(p, RUNS)]))
    journal = journal_bytes()
    swap = 0
    try:
        swap = os.stat("/swapfile").st_blocks * 512
    except OSError:
        pass
    own_home = os.path.join(OWN, "home")
    data = max(0, size(OWN_DATA) - logs_total) + max(0, size(own_home) - total([c for c in caches if inside(c, own_home)]))
    disk = space()
    categories = [
        {"id": "other-programs", "bytes": total(other_paths), "count": len(others),
         "running": sum(1 for r in others if in_use(r))},
        {"id": "cloud-runs", "bytes": runs},
        {"id": "agent-tools", "bytes": agent},
        {"id": "program-logs", "bytes": logs_total, "cleanableBytes": total(old_logs()),
         "files": len(os.listdir(LOGS)) if os.path.isdir(LOGS) else 0},
        {"id": "project-copies", "bytes": size(os.path.join(OWN, "workspace")),
         "projects": sorted(os.listdir(MIRRORS)) if os.path.isdir(MIRRORS) else []},
        {"id": "program-data", "bytes": data},
        {"id": "caches", "bytes": total(caches), "cleanableBytes": total(cache_entries())},
        {"id": "program-versions", "bytes": total([p for p, _ in rels]), "count": len(rels),
         "inUse": sum(1 for _, k in rels if k), "cleanableBytes": total([p for p, k in rels if not k])},
        {"id": "system-logs", "bytes": journal, "cleanableBytes": max(0, journal - JOURNAL_KEEP_BYTES)},
        {"id": "swap", "bytes": swap},
    ]
    known = sum(c["bytes"] for c in categories)
    categories.insert(0, {"id": "system", "bytes": max(0, disk["usedBytes"] - known)})
    save_sizes(at)
    return dict(disk, ok=True, categories=categories, measuredAt=int(at * 1000))

def remove(paths):
    """Removes what may go, checking each path again right before it goes;
    the kept sizes forget what was removed."""
    removed, failed, freed = [], [], 0
    for raw in paths:
        p = location(raw)
        reason = lock_reason(p)
        if reason:
            failed.append({"path": raw, "reason": reason}); continue
        before = size(p)
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
        except OSError as error:
            failed.append({"path": raw, "reason": "error", "message": str(error)})
        left = measure(p)
        if not os.path.lexists(p):
            removed.append(p)
        bytes_ = max(0, before - left)
        freed += bytes_
        for key in [k for k in SIZES if inside(k, p)]:
            del SIZES[key]
        if left:
            SIZES[p] = left
        parent = os.path.dirname(p)
        while inside(parent, HOME):
            if parent in SIZES:
                SIZES[parent] = max(0, SIZES[parent] - bytes_)
            if parent == HOME:
                break
            parent = os.path.dirname(parent)
    return removed, failed, freed

def change(targets):
    load_sizes()
    keep = bool(SIZES)
    forget_sizes()
    removed, failed, freed = remove(targets)
    if keep:
        save_sizes(time.time() - SIZE_CACHE_SECONDS / 2)
    return {"ok": True, "freedBytes": freed, "removed": len(removed), "failed": failed}

def clean(category):
    if category == "program-logs":
        return change(old_logs())
    if category == "caches":
        return change(cache_entries())
    if category == "program-versions":
        return change([p for p, kept in releases() if not kept])
    if category == "system-logs":
        before = journal_bytes()
        # A plain number is bytes to journalctl.
        result = subprocess.run(["sudo", "-n", "journalctl", "--vacuum-size=%d" % JOURNAL_KEEP_BYTES],
                                capture_output=True, text=True)
        if result.returncode != 0:
            return {"ok": False, "error": (result.stderr or "journalctl failed").strip()[-300:]}
        return {"ok": True, "freedBytes": max(0, before - journal_bytes()), "failed": []}
    return {"ok": False, "error": "unknown category"}

NAMED_FOLDERS = {"@runs": RUNS, "@mirrors": MIRRORS}

def listing(path):
    p = real(NAMED_FOLDERS.get(path, path) or HOME)
    if not inside(p, HOME) or not os.path.isdir(p):
        return {"ok": False, "error": "not a folder in the home folder"}
    try:
        names = os.listdir(p)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    load_sizes()
    children = [os.path.join(p, n) for n in names]
    dirs = {c for c in children if os.path.isdir(c) and not os.path.islink(c)}
    if any(c not in SIZES for c in dirs):
        SIZES.update(parse_du(du_lines(["-a", "-k", "-x", "-d", "1"], [p])))
    entries = [{"name": os.path.basename(c), "path": c, "bytes": size(c), "dir": c in dirs} for c in children]
    entries.sort(key=lambda e: -e["bytes"])
    shown = entries[:LIST_LIMIT]
    for entry in shown:
        entry["lock"] = lock_reason(entry["path"])
        role = role_of(entry["path"])
        if role:
            entry["role"] = role
    return {"ok": True, "path": p, "home": HOME, "own": OWN, "entries": shown,
            "truncated": max(0, len(entries) - LIST_LIMIT)}

if MODE == "report":
    print(json.dumps(report()))
elif MODE == "clean":
    outcome = clean(ARG)
    outcome["space"] = space()
    print(json.dumps(outcome))
elif MODE == "list":
    print(json.dumps(listing(ARG if isinstance(ARG, str) else "")))
elif MODE == "delete":
    if not isinstance(ARG, list) or not all(isinstance(x, str) for x in ARG):
        print(json.dumps({"ok": False, "error": "bad paths"}))
    else:
        outcome = change(ARG)
        outcome["space"] = space()
        print(json.dumps(outcome))
else:
    print(json.dumps({"ok": False, "error": "unknown mode"}))
`;
