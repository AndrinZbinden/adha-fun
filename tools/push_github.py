#!/usr/bin/env python3
"""Push the hooklaunch/ tree to GitHub via the Composio gateway.

Snapshot semantics: the tree is rebuilt from scratch, so local deletions
propagate. SECRETS ARE HARD-EXCLUDED — see DENY below; the executor's secret
key and the .env must never leave this machine.
"""
import base64, os, sys, requests

GATEWAY = "http://composio-gateway.flycast"
OWNER = "AndrinZbinden"
REPO = os.environ.get("PUSH_REPO", "adha-fun")
BRANCH = "main"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXCLUDE_DIRS = {".git", "__pycache__", "node_modules", ".pytest_cache", "data"}
EXCLUDE_EXT = {".pyc", ".db", ".env", ".log"}
# Belt and braces: even if one of these somehow appears outside data/, refuse it.
DENY = {"keeper.json", ".env", "hooklaunch.db"}
TEXT_EXT = {".html", ".css", ".js", ".mjs", ".py", ".md", ".json", ".txt",
            ".svg", ".yml", ".yaml", ".toml", ".gitignore", ""}


def execute(tool, arguments):
    r = requests.post(f"{GATEWAY}/internal/execute",
                      json={"tool": tool, "arguments": arguments}, timeout=180)
    r.raise_for_status()
    d = r.json()
    if d.get("error"):
        raise RuntimeError(f"{tool}: {d['error']}")
    data = d.get("data") or {}
    for key in ("data", "details"):
        if isinstance(data, dict) and key in data and isinstance(data[key], dict):
            data = data[key]
    return data


def collect_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            if fn in DENY or os.path.splitext(fn)[1] in EXCLUDE_EXT:
                continue
            if os.path.getsize(full) > 900_000:
                print(f"  SKIP (too big) {rel}")
                continue
            out.append((rel, full))
    return sorted(out)


def main():
    files = collect_files()
    for rel, _ in files:
        # keeper.mjs / test_keeper.mjs are source; the secret is data/keeper.json.
        assert os.path.basename(rel) not in DENY and not rel.startswith("data/"), \
            f"SECRET LEAK: {rel}"
    print(f"{len(files)} files -> {OWNER}/{REPO}@{BRANCH}")

    ref = execute("GITHUB_GET_A_REFERENCE",
                  {"owner": OWNER, "repo": REPO, "ref": f"heads/{BRANCH}"})
    parent = ref["object"]["sha"]
    print("parent:", parent[:10])

    tree = []
    for rel, full in files:
        raw = open(full, "rb").read()
        ext = os.path.splitext(full)[1]
        try:
            if ext in TEXT_EXT:
                content, enc = raw.decode("utf-8"), "utf-8"
            else:
                raise UnicodeDecodeError("skip", b"", 0, 1, "binary")
        except (UnicodeDecodeError, ValueError):
            content, enc = base64.b64encode(raw).decode(), "base64"
        blob = execute("GITHUB_CREATE_A_BLOB",
                       {"owner": OWNER, "repo": REPO, "content": content, "encoding": enc})
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  {enc:6} {len(raw):>7}b  {rel}")

    new_tree = execute("GITHUB_CREATE_A_TREE",
                       {"owner": OWNER, "repo": REPO, "tree": tree})
    msg = sys.argv[1] if len(sys.argv) > 1 else "Sync adha.fun"
    commit = execute("GITHUB_CREATE_A_COMMIT",
                     {"owner": OWNER, "repo": REPO, "message": msg,
                      "tree": new_tree["sha"], "parents": [parent]})
    execute("GITHUB_UPDATE_A_REFERENCE",
            {"owner": OWNER, "repo": REPO, "ref": f"heads/{BRANCH}", "sha": commit["sha"]})
    print(f"pushed https://github.com/{OWNER}/{REPO}/commit/{commit['sha']}")


if __name__ == "__main__":
    main()
