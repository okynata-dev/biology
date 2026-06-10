#!/usr/bin/env python3
"""
x-oauth-pin.py — get an OAuth 1.0a Access Token + Secret for @theBioms
via the PIN-based (out-of-band) flow. Needed because the new X dev
console only shows app keys (Consumer Key/Secret) and a Bearer Token;
posting tweets requires a USER token pair on top of the app keys.

Usage (run in the terminal where the app keys are exported):
    export X_API_KEY="<Consumer Key>"
    export X_API_SECRET="<Secret Key>"
    python3 scripts/x-oauth-pin.py

Flow:
  1. Asks X for a request token (oauth_callback=oob).
  2. Prints an authorize URL — open it in the browser that is logged in
     as @theBioms, press Authorize, copy the 7-digit PIN.
  3. Paste the PIN here; the script exchanges it for the permanent
     Access Token + Secret and prints the `wrangler secret put` lines.

No dependencies — OAuth1 HMAC-SHA1 signing is done with the stdlib.
The token pair does not expire; revoke it any time from the X app
settings (Connected apps) or by regenerating the consumer secret.
"""

import hashlib
import hmac
import base64
import os
import secrets
import ssl
import sys
import time
import urllib.parse
import urllib.request


API = "https://api.x.com"


def _ssl_ctx():
    # python.org macOS builds ship without system CA certs.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _pct(s):
    return urllib.parse.quote(str(s), safe="~")


def oauth_request(url, consumer_key, consumer_secret, token="", token_secret="", extra_oauth=None):
    """Signed POST per OAuth 1.0a (HMAC-SHA1). Returns the parsed
    form-encoded response body as a dict."""
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_version": "1.0",
    }
    if token:
        oauth["oauth_token"] = token
    if extra_oauth:
        oauth.update(extra_oauth)

    base_params = "&".join(
        f"{_pct(k)}={_pct(v)}" for k, v in sorted(oauth.items())
    )
    base = "&".join(["POST", _pct(url), _pct(base_params)])
    key = f"{_pct(consumer_secret)}&{_pct(token_secret)}"
    sig = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()
    ).decode()
    oauth["oauth_signature"] = sig

    header = "OAuth " + ", ".join(
        f'{_pct(k)}="{_pct(v)}"' for k, v in sorted(oauth.items())
    )
    req = urllib.request.Request(
        url, data=b"", method="POST",
        headers={"Authorization": header, "User-Agent": "bioms-oauth-pin"},
    )
    with urllib.request.urlopen(req, timeout=20, context=_ssl_ctx()) as r:
        return dict(urllib.parse.parse_qsl(r.read().decode()))


def main():
    ck = os.environ.get("X_API_KEY", "").strip()
    cs = os.environ.get("X_API_SECRET", "").strip()
    if not ck or not cs:
        sys.exit("Set X_API_KEY and X_API_SECRET in this shell first (export X_API_KEY=...).")

    print("→ requesting a temporary token from X…")
    try:
        rt = oauth_request(
            f"{API}/oauth/request_token", ck, cs,
            extra_oauth={"oauth_callback": "oob"},
        )
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        sys.exit(f"request_token failed: HTTP {e.code} — {body}\n"
                 "Check the app has Read AND Write permission and the keys are correct.")

    print("\nOpen this URL in the browser logged in as @theBioms,")
    print("press Authorize, and copy the PIN:\n")
    print(f"  {API}/oauth/authorize?oauth_token={rt['oauth_token']}\n")

    pin = input("PIN: ").strip()
    if not pin:
        sys.exit("No PIN entered.")

    print("→ exchanging the PIN for the permanent token…")
    at = oauth_request(
        f"{API}/oauth/access_token", ck, cs,
        token=rt["oauth_token"], token_secret=rt["oauth_token_secret"],
        extra_oauth={"oauth_verifier": pin},
    )

    print(f"\nAuthorized as: @{at.get('screen_name', '?')}\n")
    print("Now store everything as worker secrets (run from the repo root):\n")
    print(f"  echo \"{ck}\" | npx wrangler secret put X_API_KEY")
    print(f"  echo \"{cs}\" | npx wrangler secret put X_API_SECRET")
    print(f"  echo \"{at['oauth_token']}\" | npx wrangler secret put X_ACCESS_TOKEN")
    print(f"  echo \"{at['oauth_token_secret']}\" | npx wrangler secret put X_ACCESS_SECRET")
    print("\nThen clear your shell history if you care: history -p (zsh: fc -p)")


if __name__ == "__main__":
    main()
