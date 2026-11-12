#!/usr/bin/env python3
"""
CAMPUS PULSE — live survey dashboard server
World Usability Day x Data Science

Pure Python standard library. No pip install needed.

    python3 server.py                 # http://localhost:8000
    python3 server.py --port 9000
    python3 server.py --host 127.0.0.1   # only this machine can connect
    python3 server.py --regen-demo       # rebuild the 150 demo rows

Data lives in plain CSV files inside ./data :
    responses.csv        real survey responses (what volunteers submit)
    demo_responses.csv   150 generated demo rows (shown only when Demo is ON)
    settings.json        dashboard settings (demo on/off)
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import os
import random
import re
import shutil
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA = BASE / "data"
BACKUPS = DATA / "backups"
LIVE_CSV = DATA / "responses.csv"
DEMO_CSV = DATA / "demo_responses.csv"
SETTINGS = DATA / "settings.json"

# --------------------------------------------------------------------------
# Survey schema (single source of truth: the form, charts and validation all
# read from this via /api/schema)
# --------------------------------------------------------------------------

# (official name, tile code, kind, short display name)
STATES = [
    ("Andhra Pradesh", "AP", "State", None),
    ("Arunachal Pradesh", "AR", "State", None),
    ("Assam", "AS", "State", None),
    ("Bihar", "BR", "State", None),
    ("Chhattisgarh", "CG", "State", None),
    ("Goa", "GA", "State", None),
    ("Gujarat", "GJ", "State", None),
    ("Haryana", "HR", "State", None),
    ("Himachal Pradesh", "HP", "State", None),
    ("Jharkhand", "JH", "State", None),
    ("Karnataka", "KA", "State", None),
    ("Kerala", "KL", "State", None),
    ("Madhya Pradesh", "MP", "State", None),
    ("Maharashtra", "MH", "State", None),
    ("Manipur", "MN", "State", None),
    ("Meghalaya", "ML", "State", None),
    ("Mizoram", "MZ", "State", None),
    ("Nagaland", "NL", "State", None),
    ("Odisha", "OD", "State", None),
    ("Punjab", "PB", "State", None),
    ("Rajasthan", "RJ", "State", None),
    ("Sikkim", "SK", "State", None),
    ("Tamil Nadu", "TN", "State", None),
    ("Telangana", "TS", "State", None),
    ("Tripura", "TR", "State", None),
    ("Uttar Pradesh", "UP", "State", None),
    ("Uttarakhand", "UK", "State", None),
    ("West Bengal", "WB", "State", None),
    ("Andaman and Nicobar Islands", "AN", "Union Territory", "Andaman & Nicobar"),
    ("Chandigarh", "CH", "Union Territory", None),
    ("Dadra and Nagar Haveli and Daman and Diu", "DD", "Union Territory", "Dadra, Nagar Haveli, Daman & Diu"),
    ("National Capital Territory of Delhi", "DL", "Union Territory", "Delhi"),
    ("Jammu and Kashmir", "JK", "Union Territory", None),
    ("Ladakh", "LA", "Union Territory", None),
    ("Lakshadweep", "LD", "Union Territory", None),
    ("Puducherry", "PY", "Union Territory", None),
]


def _o(value, short=None, mid=None, tail=False):
    d = {"value": value, "short": short or value, "tail": tail}
    if mid is not None:
        d["mid"] = mid
    return d


FIELDS = [
    {
        "key": "state", "n": 1, "kind": "geo",
        "title": "State of origin",
        "question": "Which Indian state or union territory are you from?",
        "placeholder": "Select state or union territory",
        "options": [
            {"value": n, "short": s or n, "code": c, "group": k, "tail": False}
            for (n, c, k, s) in STATES
        ],
    },
    {
        "key": "social_hours", "n": 2, "kind": "ordinal",
        "title": "Daily social media use",
        "question": "How many hours do you spend on social media daily?",
        "placeholder": "Select hours per day",
        "options": [
            _o("Below 1 Hour", "<1h", 0.5), _o("1–2 Hours", "1–2h", 1.5),
            _o("2–4 Hours", "2–4h", 3.0), _o("4–6 Hours", "4–6h", 5.0),
            _o("Above 6 Hours", ">6h", 7.0),
        ],
    },
    {
        "key": "social_platform", "n": 3, "kind": "nominal",
        "title": "Favourite social platform",
        "question": "Which social media platform do you use the most?",
        "placeholder": "Select a platform",
        "options": [_o("Instagram"), _o("YouTube"), _o("WhatsApp"), _o("Facebook"),
                    _o("LinkedIn"), _o("Snapchat"), _o("Other", tail=True)],
    },
    {
        "key": "sleep", "n": 4, "kind": "ordinal",
        "title": "Daily sleep",
        "question": "How many hours do you sleep on average every day?",
        "placeholder": "Select hours of sleep",
        "options": [
            _o("Below 5 Hours", "<5h", 4.5), _o("5–6 Hours", "5–6h", 5.5),
            _o("6–7 Hours", "6–7h", 6.5), _o("7–8 Hours", "7–8h", 7.5),
            _o("Above 8 Hours", ">8h", 8.5),
        ],
    },
    {
        "key": "ai_platform", "n": 5, "kind": "nominal",
        "title": "Favourite AI platform",
        "question": "Which AI platform do you use the most?",
        "placeholder": "Select an AI platform",
        "options": [_o("ChatGPT"), _o("Google Gemini", "Gemini"), _o("Claude"),
                    _o("Microsoft Copilot", "Copilot"), _o("Perplexity"),
                    _o("Other", tail=True), _o("Don't Use AI", "No AI", tail=True)],
    },
    {
        "key": "activity", "n": 6, "kind": "nominal",
        "title": "Physical activity",
        "question": "Which physical activity do you participate in regularly?",
        "placeholder": "Select an activity",
        "options": [_o("Gym / Workout", "Gym"), _o("Walking"), _o("Running"), _o("Sports"),
                    _o("Yoga"), _o("Cycling"), _o("Other", tail=True),
                    _o("No Regular Physical Activity", "None", tail=True)],
    },
    {
        "key": "food", "n": 7, "kind": "nominal",
        "title": "Food habits",
        "question": "What is your food preference?",
        "placeholder": "Select food preference",
        "options": [_o("Vegetarian"), _o("Non-Vegetarian"), _o("Eggetarian"), _o("Vegan"),
                    _o("Other", tail=True)],
    },
    {
        "key": "entertainment", "n": 8, "kind": "nominal",
        "title": "Entertainment",
        "question": "What is your favourite form of entertainment?",
        "placeholder": "Select entertainment",
        "options": [_o("Movies"), _o("Web Series"), _o("Music"), _o("Gaming"), _o("Sports"),
                    _o("Reading"), _o("Social Media"), _o("Other", tail=True)],
    },
    {
        "key": "transport", "n": 9, "kind": "nominal",
        "title": "Transportation",
        "question": "What is your primary mode of transportation?",
        "placeholder": "Select transport mode",
        "options": [_o("Bus"), _o("Metro"), _o("Two-Wheeler"), _o("Car"), _o("Bicycle"),
                    _o("Walking"), _o("Other", tail=True)],
    },
    {
        "key": "career", "n": 10, "kind": "nominal",
        "title": "Career interest",
        "question": "Which career field interests you the most?",
        "placeholder": "Select a career field",
        "options": [
            _o("IT & Software Development", "IT & Software"),
            _o("Data Science & Artificial Intelligence", "Data Science & AI"),
            _o("Business & Management", "Business & Mgmt"),
            _o("Finance & Banking", "Finance & Banking"),
            _o("Government Services", "Govt. Services"),
            _o("Research & Academia", "Research & Academia"),
            _o("Entrepreneurship"), _o("Creative Fields"), _o("Other", tail=True),
        ],
    },
]

KEYS = [f["key"] for f in FIELDS]
ALLOWED = {f["key"]: {o["value"] for o in f["options"]} for f in FIELDS}
CSV_COLUMNS = ["response_id", "timestamp"] + KEYS + ["submission_key"]
ENC_WRITE = "utf-8-sig"   # BOM so Excel shows the en-dashes (1–2 Hours) correctly
ENC_READ = "utf-8-sig"


# --------------------------------------------------------------------------
# Demo data (deterministic, 150 rows, with believable correlations)
# --------------------------------------------------------------------------

STATE_WEIGHT = {
    "KA": 20, "TN": 13, "KL": 10, "AP": 6, "TS": 6, "MH": 5, "WB": 5, "UP": 4.5, "BR": 4,
    "DL": 4, "OD": 3.5, "AS": 3, "RJ": 2.5, "GJ": 2.5, "MP": 2.5, "PB": 2, "HR": 2, "JH": 2,
    "CG": 1.5, "UK": 1.5, "PY": 1.5, "GA": 1.2, "MN": 1.2, "ML": 1, "HP": 1, "JK": 1,
    "TR": 0.8, "CH": 0.8, "AR": 0.6, "NL": 0.6, "SK": 0.5, "MZ": 0.5, "AN": 0.4,
    "LA": 0.3, "LD": 0.3, "DD": 0.3,
}
METRO_STATES = {"DL", "KA", "MH", "WB", "TN", "KL", "TS", "GJ", "UP", "RJ"}
VEG_STATES = {"GJ", "RJ", "HR", "PB"}
NONVEG_STATES = {"KL", "WB", "AP", "TS", "TN", "OD", "AS", "MN", "ML", "NL", "MZ", "TR", "AR", "SK", "GA"}


def build_demo(n: int = 150, seed: int = 2026) -> list[dict]:
    rng = random.Random(seed)
    F = {f["key"]: f for f in FIELDS}
    vals = {k: [o["value"] for o in F[k]["options"]] for k in KEYS}
    code_of = {o["value"]: o["code"] for o in F["state"]["options"]}

    def pick(items, weights):
        return rng.choices(items, weights=weights, k=1)[0]

    def weighted(key, base, mult=None):
        mult = mult or {}
        return pick(vals[key], [base[v] * mult.get(v, 1.0) for v in vals[key]])

    now = datetime.now().astimezone().replace(microsecond=0)
    start = now - timedelta(hours=6)
    span = 6 * 3600 - 300
    offsets = sorted(rng.uniform(0, span) for _ in range(n))

    rows = []
    for i in range(n):
        state = pick(vals["state"], [STATE_WEIGHT[code_of[s]] for s in vals["state"]])
        code = code_of[state]
        s_idx = pick(range(5), [7, 20, 33, 27, 13])
        social_hours = vals["social_hours"][s_idx]
        sleep_w = [0.03 + 0.04 * s_idx, 0.10 + 0.05 * s_idx, 0.27 + 0.02 * s_idx,
                   0.38 - 0.06 * s_idx, 0.22 - 0.05 * s_idx]
        sl_idx = pick(range(5), sleep_w)
        sleep = vals["sleep"][sl_idx]

        pf = {"Instagram": 36, "YouTube": 24, "WhatsApp": 20, "Facebook": 3,
              "LinkedIn": 6, "Snapchat": 6, "Other": 5}
        if s_idx >= 3:
            pm = {"Instagram": 1.3, "Snapchat": 1.5, "YouTube": 1.15, "WhatsApp": 0.8, "LinkedIn": 0.5}
        elif s_idx <= 1:
            pm = {"WhatsApp": 1.6, "LinkedIn": 1.8, "Instagram": 0.7}
        else:
            pm = {}
        platform = weighted("social_platform", pf, pm)

        career = weighted("career", {
            "IT & Software Development": 21, "Data Science & Artificial Intelligence": 23,
            "Business & Management": 13, "Finance & Banking": 9, "Government Services": 8,
            "Research & Academia": 8, "Entrepreneurship": 8, "Creative Fields": 7, "Other": 3})

        ai_base = {"ChatGPT": 44, "Google Gemini": 21, "Claude": 9, "Microsoft Copilot": 6,
                   "Perplexity": 7, "Other": 4, "Don't Use AI": 9}
        if career in ("Data Science & Artificial Intelligence", "IT & Software Development"):
            am = {"Don't Use AI": 0.3, "Claude": 1.8, "Perplexity": 1.3, "Microsoft Copilot": 1.3}
        elif career in ("Government Services", "Creative Fields"):
            am = {"Don't Use AI": 2.0}
        else:
            am = {}
        ai = weighted("ai_platform", ai_base, am)

        act_base = {"Gym / Workout": 22, "Walking": 20, "Running": 8, "Sports": 18, "Yoga": 5,
                    "Cycling": 4, "Other": 4, "No Regular Physical Activity": 19}
        am2 = {"No Regular Physical Activity": 1.6} if s_idx >= 3 else (
            {"No Regular Physical Activity": 0.6} if sl_idx >= 3 else {})
        activity = weighted("activity", act_base, am2)

        fm = {}
        if code in VEG_STATES:
            fm = {"Vegetarian": 2.2}
        elif code in NONVEG_STATES:
            fm = {"Non-Vegetarian": 1.3}
        food = weighted("food", {"Vegetarian": 29, "Non-Vegetarian": 56, "Eggetarian": 9,
                                 "Vegan": 2, "Other": 4}, fm)

        em = {"Social Media": 1.8, "Gaming": 1.2} if s_idx >= 3 else {"Reading": 1.5}
        entertainment = weighted("entertainment", {
            "Movies": 17, "Web Series": 17, "Music": 22, "Gaming": 11, "Sports": 9,
            "Reading": 5, "Social Media": 14, "Other": 5}, em)

        tm = {"Metro": 3.0, "Two-Wheeler": 0.7} if code in METRO_STATES else {}
        transport = weighted("transport", {"Bus": 22, "Metro": 15, "Two-Wheeler": 30, "Car": 8,
                                           "Bicycle": 4, "Walking": 17, "Other": 4}, tm)

        ts = (start + timedelta(seconds=offsets[i])).isoformat(timespec="seconds")
        rows.append({
            "response_id": f"D-{i + 1:03d}", "timestamp": ts, "state": state,
            "social_hours": social_hours, "social_platform": platform, "sleep": sleep,
            "ai_platform": ai, "activity": activity, "food": food,
            "entertainment": entertainment, "transport": transport, "career": career,
            "submission_key": "",
        })
    return rows


# --------------------------------------------------------------------------
# CSV store
# --------------------------------------------------------------------------

def _write_csv_atomic(path: Path, rows: list[dict]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding=ENC_WRITE) as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _valid(row: dict) -> bool:
    return all(row.get(k) in ALLOWED[k] for k in KEYS)


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.bump = 0
        self._cache: dict[Path, tuple] = {}
        self.skipped = 0

    # ---- low level -------------------------------------------------------
    @staticmethod
    def _sig(p: Path):
        try:
            s = p.stat()
            return (s.st_mtime_ns, s.st_size)
        except FileNotFoundError:
            return None

    def _read(self, p: Path) -> list[dict]:
        with self.lock:
            sig = self._sig(p)
            hit = self._cache.get(p)
            if hit and hit[0] == sig:
                return hit[1]
            rows: list[dict] = []
            skipped = 0
            if sig is not None:
                with p.open(newline="", encoding=ENC_READ) as f:
                    for r in csv.DictReader(f):
                        if _valid(r):
                            rows.append(r)
                        else:
                            skipped += 1
            if p == LIVE_CSV:
                self.skipped = skipped
            self._cache[p] = (sig, rows)
            return rows

    def ensure_files(self, regen_demo: bool = False) -> None:
        DATA.mkdir(exist_ok=True)
        if not LIVE_CSV.exists():
            _write_csv_atomic(LIVE_CSV, [])
        if regen_demo or not DEMO_CSV.exists():
            _write_csv_atomic(DEMO_CSV, build_demo())
        if not SETTINGS.exists():
            SETTINGS.write_text(json.dumps({"demo_enabled": True}, indent=2))

    # ---- settings --------------------------------------------------------
    def demo_enabled(self) -> bool:
        try:
            return bool(json.loads(SETTINGS.read_text()).get("demo_enabled", True))
        except Exception:
            return True

    def set_demo(self, enabled: bool) -> None:
        with self.lock:
            SETTINGS.write_text(json.dumps({"demo_enabled": bool(enabled)}, indent=2))
            self.bump += 1

    # ---- versioning ------------------------------------------------------
    def version(self) -> str:
        raw = f"{self.bump}|{self._sig(LIVE_CSV)}|{self._sig(DEMO_CSV)}|{self._sig(SETTINGS)}"
        return hashlib.md5(raw.encode()).hexdigest()[:10]

    # ---- reads -----------------------------------------------------------
    def snapshot(self) -> dict:
        with self.lock:
            live = self._read(LIVE_CSV)
            demo = self._read(DEMO_CSV)
            enabled = self.demo_enabled()

            def shape(r, src):
                d = {"id": r["response_id"], "ts": r["timestamp"], "src": src}
                d.update({k: r[k] for k in KEYS})
                return d

            rows = [shape(r, "live") for r in live]
            if enabled:
                rows = [shape(r, "demo") for r in demo] + rows
            return {
                "version": self.version(),
                "demo_enabled": enabled,
                "counts": {"live": len(live), "demo": len(demo)},
                "skipped": self.skipped,
                "rows": rows,
            }

    def export_csv(self, include_demo: bool) -> bytes:
        with self.lock:
            rows = list(self._read(LIVE_CSV))
            if include_demo:
                rows = list(self._read(DEMO_CSV)) + rows
        import io
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=CSV_COLUMNS[:-1], extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
        return ("﻿" + buf.getvalue()).encode("utf-8")

    # ---- writes ----------------------------------------------------------
    def add(self, key: str, answers: dict) -> dict:
        with self.lock:
            rows = self._read(LIVE_CSV)
            if key:
                for r in rows:
                    if r.get("submission_key") == key:
                        return {"duplicate": True, "id": r["response_id"]}
            nums = []
            for r in rows:
                try:
                    nums.append(int(r["response_id"].split("-")[1]))
                except Exception:
                    pass
            rid = f"R-{(max(nums) if nums else 0) + 1:04d}"
            row = {"response_id": rid,
                   "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
                   "submission_key": key or ""}
            row.update({k: answers[k] for k in KEYS})

            needs_nl = False
            if LIVE_CSV.exists() and LIVE_CSV.stat().st_size:
                with LIVE_CSV.open("rb") as fb:
                    fb.seek(-1, os.SEEK_END)
                    needs_nl = fb.read(1) not in (b"\n", b"\r")
            with LIVE_CSV.open("a", newline="", encoding="utf-8") as f:
                if needs_nl:
                    f.write("\r\n")
                csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore").writerow(row)
                f.flush()
                os.fsync(f.fileno())
            self.bump += 1
            return {"duplicate": False, "id": rid}

    def undo(self, rid: str) -> bool:
        with self.lock:
            rows = list(self._read(LIVE_CSV))
            keep = [r for r in rows if r["response_id"] != rid]
            if len(keep) == len(rows):
                return False
            _write_csv_atomic(LIVE_CSV, keep)
            self.bump += 1
            return True

    def reset_live(self) -> str | None:
        with self.lock:
            backup = None
            if LIVE_CSV.exists() and len(self._read(LIVE_CSV)):
                BACKUPS.mkdir(exist_ok=True)
                backup = BACKUPS / f"responses-{datetime.now():%Y%m%d-%H%M%S}.csv"
                shutil.copy2(LIVE_CSV, backup)
            _write_csv_atomic(LIVE_CSV, [])
            self.bump += 1
            return backup.name if backup else None


STORE = Store()


def validate(answers) -> dict:
    errors = {}
    if not isinstance(answers, dict):
        return {"_": "Invalid submission."}
    for f in FIELDS:
        v = answers.get(f["key"])
        if not v:
            errors[f["key"]] = "Please select an option."
        elif v not in ALLOWED[f["key"]]:
            errors[f["key"]] = "That option is not valid. Please choose from the list."
    return errors


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

SCHEMA_JSON = json.dumps({"fields": FIELDS, "csv_columns": CSV_COLUMNS}, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "CampusPulse/1.0"

    def log_message(self, fmt, *args):  # keep the console quiet, show only API writes
        line = fmt % args
        if "POST" in line or " 4" in line or " 5" in line:
            print(f"  {self.address_string()}  {line}")

    # ---- helpers ---------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20_000:
                return None
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return None

    def _static(self, rel: str) -> None:
        target = (STATIC / rel).resolve()
        try:
            target.relative_to(STATIC.resolve())
        except ValueError:
            return self._json(403, {"ok": False, "error": "Forbidden"})
        if not target.is_file():
            return self._json(404, {"ok": False, "error": "Not found"})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".woff2":
            ctype = "font/woff2"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8" if "charset" not in ctype else ""
        cache = "public, max-age=86400" if target.suffix in (".woff2",) or "vendor" in target.parts \
            else "no-cache"
        self._send(200, target.read_bytes(), ctype, {"Cache-Control": cache})

    # ---- public / admin access control -----------------------------------
    # ngrok forwards visitors from this very machine, so the socket address alone says
    # "127.0.0.1" for everyone. A request is ADMIN only if it comes from this machine,
    # addressed to localhost, with no proxy/tunnel headers. Everyone else is PUBLIC and
    # may only open the volunteer form and submit a response.
    def _is_admin(self) -> bool:
        h = self.headers
        if any(h.get(k) for k in ("X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "Ngrok-Trace-Id")):
            return False
        host = (h.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return host in ("localhost", "127.0.0.1", "::1", "")
        if TRUST_LAN and (ip.startswith(("192.168.", "10.")) or re.match(r"172\.(1[6-9]|2\d|3[01])\.", ip)):
            return True
        return False

    def _public_ip(self) -> str:
        xff = self.headers.get("X-Forwarded-For")
        return xff.split(",")[0].strip() if xff else self.client_address[0]

    def _rate_ok(self) -> bool:          # max 40 submissions / minute / visitor
        now, ip = time.time(), self._public_ip()
        hits = [t for t in RATE.get(ip, []) if now - t < 60]
        if len(hits) >= 40:
            RATE[ip] = hits
            return False
        hits.append(now)
        RATE[ip] = hits
        if len(RATE) > 5000:
            RATE.clear()
        return True

    def _public_get_ok(self, path: str) -> bool:
        return (path in ("/form", "/form/", "/favicon.ico", "/favicon.svg", "/api/schema", "/healthz")
                or path.startswith("/static/"))

    # ---- routes ----------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if not self._is_admin() and not self._public_get_ok(path):
            if path in ("/", "/index.html"):
                self.send_response(302)
                self.send_header("Location", "/form")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self._json(404, {"ok": False, "error": "Not found"})
        if path in ("/", "/index.html", "/form", "/form/"):
            return self._static("index.html")
        if path == "/favicon.ico" or path == "/favicon.svg":
            return self._static("favicon.svg")
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/api/schema":
            return self._send(200, SCHEMA_JSON, "application/json; charset=utf-8")
        if path == "/api/data":
            return self._json(200, STORE.snapshot())
        if path == "/api/export.csv":
            q = parse_qs(url.query)
            inc = q.get("demo", ["0"])[0] == "1"
            name = f"campus-pulse-{datetime.now():%Y%m%d-%H%M}{'-with-demo' if inc else ''}.csv"
            return self._send(200, STORE.export_csv(inc), "text/csv; charset=utf-8",
                              {"Content-Disposition": f'attachment; filename="{name}"'})
        if path == "/api/stream":
            return self._stream()
        if path == "/healthz":
            return self._json(200, {"ok": True})
        return self._json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        admin = self._is_admin()
        if not admin and path != "/api/submit":
            return self._json(403, {"ok": False, "error": "Not allowed."})
        if not admin and not self._rate_ok():
            return self._json(429, {"ok": False, "errors": {}, "error": "Too many submissions. Wait a minute."})
        body = self._body()
        if body is None:
            return self._json(400, {"ok": False, "error": "Invalid or oversized JSON body."})

        if path == "/api/submit":
            answers = body.get("answers")
            errors = validate(answers)
            if errors:
                return self._json(422, {"ok": False, "errors": errors})
            key = str(body.get("key") or "")[:64]
            res = STORE.add(key, answers)
            return self._json(200 if res["duplicate"] else 201,
                              {"ok": True, "version": STORE.version(), **res})

        if path == "/api/demo":
            STORE.set_demo(bool(body.get("enabled")))
            return self._json(200, {"ok": True, "demo_enabled": STORE.demo_enabled()})

        if path == "/api/undo":
            ok = STORE.undo(str(body.get("id", "")))
            return self._json(200 if ok else 404, {"ok": ok})

        if path == "/api/reset-live":
            if not admin:
                return self._json(403, {"ok": False,
                                        "error": "Reset is only allowed from the machine running the server."})
            if body.get("confirm") is not True:
                return self._json(400, {"ok": False, "error": "Confirmation required."})
            return self._json(200, {"ok": True, "backup": STORE.reset_live()})

        return self._json(404, {"ok": False, "error": "Not found"})

    # ---- live updates (Server-Sent Events) -------------------------------
    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last, idle = None, 0
        try:
            while True:
                v = STORE.version()
                if v != last:
                    last, idle = v, 0
                    self.wfile.write(f"event: update\ndata: {json.dumps({'version': v})}\n\n".encode())
                    self.wfile.flush()
                else:
                    idle += 1
                    if idle % 30 == 0:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                time.sleep(0.4)
        except (BrokenPipeError, ConnectionError, OSError):
            return


TRUST_LAN = False
RATE: dict = {}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Campus Pulse live survey dashboard")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0 = reachable on the LAN)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--trust-lan", action="store_true", help="treat devices on your private Wi-Fi/LAN as admins (dashboard access)")
    ap.add_argument("--regen-demo", action="store_true", help="rebuild demo_responses.csv")
    args = ap.parse_args()
    global TRUST_LAN
    TRUST_LAN = args.trust_lan

    STORE.ensure_files(regen_demo=args.regen_demo)
    srv = Server((args.host, args.port), Handler)
    live, demo = len(STORE._read(LIVE_CSV)), len(STORE._read(DEMO_CSV))
    ip = lan_ip() if args.host in ("0.0.0.0", "") else None

    print("\n  CAMPUS PULSE  ·  WHAT CAMPUS THINKS. WHAT CAMPUS DOES.")
    print("  " + "─" * 58)
    print(f"  Dashboard      http://localhost:{args.port}/")
    print(f"  Volunteer form http://localhost:{args.port}/form")
    if ip:
        print(f"  On your Wi-Fi  http://{ip}:{args.port}/form   <- open on volunteers' phones")
    print(f"  Data           {LIVE_CSV.relative_to(BASE)}  ({live} live)   "
          f"{DEMO_CSV.relative_to(BASE)}  ({demo} demo)")
    print(f"  Demo data      {'ON' if STORE.demo_enabled() else 'OFF'}   (toggle it in the dashboard header)")
    print("  Ctrl+C to stop\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
