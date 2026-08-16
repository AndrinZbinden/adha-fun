#!/usr/bin/env python3
"""Replace main's entire history with a single root commit of the current tree.

Past commit messages carry a co-author trailer that cannot be edited in place:
a commit message is part of the commit hash, so rewriting one rewrites every
descendant. This builds one parentless commit from the working tree and force
-moves the branch onto it. The code is unchanged; the history is gone for good.
"""
import base64, os, sys, requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from push_github import (OWNER, REPO, BRANCH, TEXT_EXT, DENY,
                         execute, collect_files)


def main():
    files = collect_files()
    for rel, _ in files:
        assert os.path.basename(rel) not in DENY and not rel.startswith("data/"), \
            f"SECRET LEAK: {rel}"
    print(f"{len(files)} files -> {OWNER}/{REPO}@{BRANCH} (root commit)")

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

    new_tree = execute("GITHUB_CREATE_A_TREE",
                       {"owner": OWNER, "repo": REPO, "tree": tree})
    msg = sys.argv[1] if len(sys.argv) > 1 else "Adha: launch a coin with a hook"

    # No parents: this becomes the repository's first and only commit.
    commit = execute("GITHUB_CREATE_A_COMMIT",
                     {"owner": OWNER, "repo": REPO, "message": msg,
                      "tree": new_tree["sha"], "parents": []})
    execute("GITHUB_UPDATE_A_REFERENCE",
            {"owner": OWNER, "repo": REPO, "ref": f"heads/{BRANCH}",
             "sha": commit["sha"], "force": True})
    print(f"squashed to https://github.com/{OWNER}/{REPO}/commit/{commit['sha']}")


if __name__ == "__main__":
    main()
