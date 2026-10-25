#!/usr/bin/env python3
"""Usage: python3 scripts/set-base-app-id.py <base_app_id> [builder_code]
Adds <meta name="base:app_id"> (+ optional base:builder_code) to index.html <head> and the
"app" block with base:app_id to .well-known/farcaster.json (existing miniapp block kept)."""
import json, re, sys
app_id = sys.argv[1].strip(); code = sys.argv[2].strip() if len(sys.argv) > 2 else None
assert re.fullmatch(r"[A-Za-z0-9_-]{6,64}", app_id), "unexpected app id format"
s = open("index.html").read()
s = re.sub(r'\s*<meta name="base:(app_id|builder_code)" content="[^"]*" />', "", s)
tags = f'\n  <meta name="base:app_id" content="{app_id}" />'
if code: tags += f'\n  <meta name="base:builder_code" content="{code}" />'
s = s.replace("<title>Asteroid Shooter</title>", "<title>Asteroid Shooter</title>" + tags, 1)
open("index.html", "w").write(s)
f = ".well-known/farcaster.json"; m = json.load(open(f))
m["app"] = {"name": "Asteroid Shooter", "description": "Arcade asteroid shooter on Base with an onchain leaderboard.",
            "url": "https://asteroid-shooter-alpha.vercel.app", "base:app_id": app_id}
m.setdefault("version", "1")
json.dump(m, open(f, "w"), indent=2); open(f, "a").write("\n")
print("ok:", app_id)
