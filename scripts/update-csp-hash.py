#!/usr/bin/env python3
"""Recompute the sha256 hash of the inline <script> in index.html and write it into the
Content-Security-Policy(-Report-Only) headers in vercel.json.
Run after ANY edit to the inline script:  python3 scripts/update-csp-hash.py
"""
import base64, hashlib, json, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "index.html").read_text(encoding="utf-8")
inline = re.findall(r"<script>(.*?)</script>", html, re.S)
if not inline:
    sys.exit("no inline <script> found")
hashes = ["'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode("utf-8")).digest()).decode() for s in inline]

cfg_path = root / "vercel.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
changed = 0
for block in cfg.get("headers", []):
    for h in block.get("headers", []):
        if h["key"].lower().startswith("content-security-policy") and "script-src" in h["value"]:
            parts = []
            for d in h["value"].split(";"):
                d = d.strip()
                if d.startswith("script-src"):
                    toks = [t for t in d.split() if not t.startswith("'sha256-")]
                    d = " ".join(toks[:2] + hashes + toks[2:])
                parts.append(d)
            h["value"] = "; ".join(p for p in parts if p)
            changed += 1
cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
print("updated", changed, "CSP header(s) with", " ".join(hashes))
