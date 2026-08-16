#!/usr/bin/env python3
"""Content-hash every local js/css reference so Cloudflare cannot serve stale code.

Cloudflare rewrites our no-cache header on static assets to max-age=14400, so a
browser keeps running a four-hour-old bundle after a deploy. Stamping the URL
with a hash of the file contents makes each deploy a different URL.

Covers both <script src>/<link href> in HTML and the dynamic import() calls in
app.js, which were previously unstamped and therefore always stale.
"""
import re, glob, hashlib, os

PUB = os.path.join(os.path.dirname(__file__), "..", "public")
os.chdir(PUB)


def h(fn):
    return hashlib.sha1(open(fn, "rb").read()).hexdigest()[:8] if os.path.exists(fn) else None


def stamp(m):
    pre, fn, post = m.group(1), m.group(2), m.group(3)
    v = h(fn)
    return f"{pre}{fn}?v={v}{post}" if v else m.group(0)


changed = []

def stamp_js(f):
    """Stamp every local module URL inside one js file."""
    s = open(f, encoding="utf-8").read()
    # dynamic import()/new Worker() targets, in ANY module. A single unstamped
    # one (launches-view.js importing launch-flow.js) made Cloudflare serve a
    # second, hours-old copy of the same module alongside the fresh one.
    s2 = re.sub(r'(new URL\(")([A-Za-z0-9_.-]+\.js)(?:\?v=[0-9a-f]{8})?(")', stamp, s)
    s2 = re.sub(r'(api\(")([A-Za-z0-9_.-]+\.js)(?:\?v=[0-9a-f]{8})?(")', stamp, s2)
    if s2 != s:
        open(f, "w", encoding="utf-8").write(s2)
        changed.append(f)
        return True
    return False


# Leaf modules first, then app.js: stamping a module changes its own hash, so
# app.js has to be rewritten afterwards to point at the new URLs, and the HTML
# hash last of all.
for f in sorted(glob.glob("*.js")):
    if f != "app.js":
        stamp_js(f)
stamp_js("app.js")

for f in sorted(glob.glob("*.html")):
    s = open(f, encoding="utf-8").read()
    s2 = re.sub(r'(src=")([A-Za-z0-9_.-]+\.js)(?:\?v=[0-9a-f]{8})?(")', stamp, s)
    s2 = re.sub(r'(href=")([A-Za-z0-9_.-]+\.css)(?:\?v=[0-9a-f]{8})?(")', stamp, s2)
    if s2 != s:
        open(f, "w", encoding="utf-8").write(s2)
        changed.append(f)

print("stamped:", changed or "nothing changed")
for f in sorted(glob.glob("*.html"))[:1]:
    for m in re.findall(r'[A-Za-z0-9_.-]+\.(?:js|css)\?v=[0-9a-f]{8}', open(f, encoding="utf-8").read()):
        print("  ", m)
print("app.js imports:")
for m in re.findall(r'new URL\("[^"]+"', open("app.js", encoding="utf-8").read()):
    print("  ", m)
