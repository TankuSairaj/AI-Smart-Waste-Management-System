"""AI-Assisted Smart Waste Management - Flask backend.

Run:  python app.py      then open http://127.0.0.1:5000
Data is stored in SQLite (smartwaste.db, created automatically).
The AI key stays on the server: set ANTHROPIC_API_KEY in a .env file.
"""
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()
BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE", os.path.join(BASE, "smartwaste.db"))
AI_MODEL = os.environ.get("AI_MODEL", "claude-sonnet-4-6")  # used only with ANTHROPIC_API_KEY
# Free option: Google Gemini. The first model is tried first; if it is unavailable the next one is used.
GEMINI_MODELS = [m for m in (os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), "gemini-3.5-flash-lite") if m]


def ai_configured():
    return bool(os.environ.get("GEMINI_API_KEY", "").strip() or os.environ.get("ANTHROPIC_API_KEY", "").strip())
CATEGORIES = ["Plastic", "Paper", "Food waste", "Metal", "Glass", "Other"]
REPORT_TYPES = CATEGORIES[:5] + ["Mixed"]

app = Flask(__name__, static_folder="static", static_url_path="")
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "dev-secret-change-me"),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), location TEXT NOT NULL,
  type TEXT NOT NULL, description TEXT NOT NULL, image TEXT DEFAULT '', lat REAL, lng REAL,
  created_at INTEGER NOT NULL, is_sample INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS detections(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), location TEXT NOT NULL,
  source TEXT NOT NULL, items TEXT NOT NULL, severity TEXT DEFAULT '', summary TEXT DEFAULT '',
  thumb TEXT DEFAULT '', lat REAL, lng REAL, created_at INTEGER NOT NULL, is_sample INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, created_at INTEGER NOT NULL);
"""


# ---------- database helpers ----------
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn:
        conn.close()


def now_ms():
    return int(time.time() * 1000)


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    if conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0] == 0:
        t, day = now_ms(), 86400000
        conn.executemany(
            "INSERT INTO reports(location,type,description,lat,lng,created_at,is_sample) VALUES(?,?,?,?,?,?,1)",
            [("Canteen Block, rear entrance", "Food waste", "Bins overflowing after lunch hours. Flies gathering around the area.", 17.3858, 78.4874, t - 2 * day),
             ("Library lawn", "Plastic", "Water bottles and snack wrappers left near the benches.", 17.3846, 78.4859, t - day),
             ("Hostel Gate", "Paper", "Stack of discarded notes and cartons beside the gate.", 17.3839, 78.4881, t - 5 * 3600000)])
        conn.executemany(
            "INSERT INTO detections(location,source,items,severity,lat,lng,created_at,is_sample) VALUES(?,?,?,?,?,?,?,1)",
            [("Sports ground", "Sample", json.dumps([{"category": "Plastic", "count": 6}, {"category": "Metal", "count": 3}]), "medium", 17.3868, 78.4852, t - 3 * day),
             ("Admin block parking", "Sample", json.dumps([{"category": "Paper", "count": 4}, {"category": "Glass", "count": 2}, {"category": "Food waste", "count": 1}]), "medium", 17.3855, 78.4843, t - day)])
    conn.commit()
    conn.close()


# ---------- auth helpers ----------
def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    row = db().execute("SELECT id,name,email FROM users WHERE id=?", (uid,)).fetchone()
    return dict(row) if row else None


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user():
            return err(401, "auth", "Log in or create an account to continue.")
        return fn(*args, **kwargs)
    return wrapper


def err(status, code, message):
    return jsonify(error=code, message=message), status


def body():
    return request.get_json(silent=True) or {}


def text(v, max_len):
    return str(v or "").strip()[:max_len]


def coord(v, lo, hi):
    try:
        f = float(v)
        return f if lo <= f <= hi else None
    except (TypeError, ValueError):
        return None


def clean_image(v, max_len):
    v = v if isinstance(v, str) else ""
    return v if v.startswith("data:image/") and len(v) <= max_len else ""


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


# ---------- pages ----------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    return jsonify(ai=ai_configured(), user=current_user())


# ---------- accounts ----------
@app.post("/api/register")
def register():
    d = body()
    name, email, pw = text(d.get("name"), 80), text(d.get("email"), 120).lower(), str(d.get("password") or "")
    if len(name) < 2:
        return err(400, "name", "Enter your name.")
    if not EMAIL_RE.match(email):
        return err(400, "email", "Enter a valid email address.")
    if len(pw) < 6:
        return err(400, "password", "Password must be at least 6 characters.")
    try:
        cur = db().execute("INSERT INTO users(name,email,password_hash,created_at) VALUES(?,?,?,?)",
                           (name, email, generate_password_hash(pw), now_ms()))
        db().commit()
    except sqlite3.IntegrityError:
        return err(409, "exists", "An account with this email already exists. Log in instead.")
    session["uid"] = cur.lastrowid
    return jsonify(user={"id": cur.lastrowid, "name": name, "email": email}), 201


@app.post("/api/login")
def login():
    d = body()
    row = db().execute("SELECT * FROM users WHERE email=?", (text(d.get("email"), 120).lower(),)).fetchone()
    if not row or not check_password_hash(row["password_hash"], str(d.get("password") or "")):
        return err(401, "credentials", "Email or password is incorrect.")
    session["uid"] = row["id"]
    return jsonify(user={"id": row["id"], "name": row["name"], "email": row["email"]})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------- reports ----------
REPORT_SQL = ("SELECT r.*, u.name AS author FROM reports r LEFT JOIN users u ON u.id=r.user_id "
              "ORDER BY r.created_at DESC LIMIT 200")


@app.get("/api/reports")
def list_reports():
    rows = db().execute(REPORT_SQL).fetchall()
    return jsonify(reports=[{
        "id": r["id"], "location": r["location"], "type": r["type"], "description": r["description"],
        "image": r["image"], "lat": r["lat"], "lng": r["lng"], "time": r["created_at"],
        "by": r["author"] or "", "sample": bool(r["is_sample"]), "userId": r["user_id"]} for r in rows])


@app.post("/api/reports")
@login_required
def create_report():
    d = body()
    location, desc, rtype = text(d.get("location"), 120), text(d.get("description"), 1000), text(d.get("type"), 20)
    if len(location) < 3:
        return err(400, "location", "Enter a location name (at least 3 characters).")
    if rtype not in REPORT_TYPES:
        return err(400, "type", "Select a valid waste type.")
    if len(desc) < 10:
        return err(400, "description", "Describe the problem in at least 10 characters.")
    cur = db().execute(
        "INSERT INTO reports(user_id,location,type,description,image,lat,lng,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (session["uid"], location, rtype, desc, clean_image(d.get("image"), 400000),
         coord(d.get("lat"), -90, 90), coord(d.get("lng"), -180, 180), now_ms()))
    db().commit()
    return jsonify(id=cur.lastrowid), 201


@app.delete("/api/reports/<int:rid>")
@login_required
def delete_report(rid):
    row = db().execute("SELECT user_id FROM reports WHERE id=?", (rid,)).fetchone()
    if not row:
        return err(404, "missing", "Report not found.")
    if row["user_id"] != session["uid"]:
        return err(403, "forbidden", "You can only delete reports you submitted.")
    db().execute("DELETE FROM reports WHERE id=?", (rid,))
    db().commit()
    return jsonify(ok=True)


# ---------- detections ----------
def detection_json(r):
    return {"id": r["id"], "time": r["created_at"], "location": r["location"], "source": r["source"],
            "items": json.loads(r["items"]), "severity": r["severity"], "summary": r["summary"],
            "thumb": r["thumb"], "lat": r["lat"], "lng": r["lng"], "by": r["author"] or "",
            "sample": bool(r["is_sample"])}


@app.get("/api/detections")
def list_detections():
    rows = db().execute("SELECT d.*, u.name AS author FROM detections d LEFT JOIN users u ON u.id=d.user_id "
                        "ORDER BY d.created_at DESC LIMIT 100").fetchall()
    return jsonify(detections=[detection_json(r) for r in rows])


def clean_items(raw):
    merged = {}
    for it in raw if isinstance(raw, list) else []:
        cat = norm_cat(it.get("category") if isinstance(it, dict) else "")
        try:
            n = max(1, min(99, int(it.get("count", 1))))
        except (TypeError, ValueError):
            n = 1
        merged[cat] = min(999, merged.get(cat, 0) + n)
    return [{"category": c, "count": n} for c, n in merged.items()]


def norm_cat(c):
    s = str(c or "").lower()
    for key, cat in (("plastic", "Plastic"), ("paper", "Paper"), ("card", "Paper"), ("food", "Food waste"),
                     ("organic", "Food waste"), ("metal", "Metal"), ("can", "Metal"), ("glass", "Glass")):
        if key in s:
            return cat
    return "Other"


def save_detection(d, source, items, severity="", summary=""):
    cur = db().execute(
        "INSERT INTO detections(user_id,location,source,items,severity,summary,thumb,lat,lng,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (session["uid"], text(d.get("location"), 120), source, json.dumps(items), severity, summary,
         clean_image(d.get("thumb"), 60000), coord(d.get("lat"), -90, 90), coord(d.get("lng"), -180, 180), now_ms()))
    db().commit()
    return cur.lastrowid


@app.post("/api/detections")
@login_required
def create_manual_detection():
    d = body()
    if len(text(d.get("location"), 120)) < 3:
        return err(400, "location", "Enter the location name (at least 3 characters).")
    items = clean_items(d.get("items"))
    if not items:
        return err(400, "items", "Select at least one waste type.")
    return jsonify(id=save_detection(d, "Manual", items, "low")), 201


@app.delete("/api/detections")
@login_required
def clear_my_detections():
    db().execute("DELETE FROM detections WHERE user_id=?", (session["uid"],))
    db().commit()
    return jsonify(ok=True)


PROMPT = """You are analysing a photo from a college campus for a waste management system.
List only waste that is actually visible. Do not guess about things you cannot see.
Respond with ONLY a JSON object, no other text, in this shape:
{"items":[{"category":"Plastic|Paper|Food waste|Metal|Glass|Other","count":<estimated number of visible items, integer>,"note":"<short description>"}],
"severity":"none|low|medium|high",
"summary":"<one sentence on what the scene shows>",
"suggestions":["<3 to 5 practical cleaning and collection steps for this scene>"]}
If no waste is visible, return an empty items array and severity "none"."""


def call_claude(image_b64):
    """Call the Anthropic Messages API with the standard library only (no extra packages needed)."""
    payload = json.dumps({
        "model": AI_MODEL, "max_tokens": 1000,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
            {"type": "text", "text": PROMPT}]}]}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=payload, method="POST",
        headers={"content-type": "application/json", "x-api-key": os.environ["ANTHROPIC_API_KEY"].strip(),
                 "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.load(resp)
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def call_gemini(image_b64):
    """Call Google Gemini (free tier available) using the standard library only."""
    payload = json.dumps({
        "contents": [{"parts": [{"inline_data": {"mime_type": "image/jpeg", "data": image_b64}}, {"text": PROMPT}]}],
        "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 2000, "temperature": 0.2}}).encode("utf-8")
    for model in GEMINI_MODELS:
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", data=payload, method="POST",
            headers={"content-type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"].strip()})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 503) and model != GEMINI_MODELS[-1]:
                app.logger.warning("Gemini model %s unavailable (%s), trying the next one", model, exc.code)
                continue
            raise
        parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts)
    return ""


def call_ai(image_b64):
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return call_gemini(image_b64)
    return call_claude(image_b64)


@app.post("/api/analyze")
@login_required
def analyze():
    if not ai_configured():
        return err(503, "ai_not_configured", "AI analysis is not configured on the server. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to the .env file.")
    d = body()
    image = d.get("image") if isinstance(d.get("image"), str) else ""
    if not image.startswith("data:image/jpeg;base64,") or len(image) > 6_000_000:
        return err(400, "image", "Send a JPEG image under 6 MB.")
    if len(text(d.get("location"), 120)) < 3:
        return err(400, "location", "Enter the location name (at least 3 characters).")
    try:
        raw = call_ai(image.split(",", 1)[1])
        result = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc).get("error", {}).get("message", "")
        except Exception:
            detail = ""
        app.logger.warning("AI HTTP %s: %s", exc.code, detail)
        if exc.code in (401, 403) or "api key" in detail.lower():
            return err(502, "ai_key", "The API key was rejected. Create a new key and update the .env file.")
        if exc.code == 429:
            return err(502, "ai_limit", "The free usage limit was reached. Wait a minute and try again.")
        return err(502, "ai_failed", f"The AI service returned an error ({exc.code}). {detail}".strip())
    except urllib.error.URLError as exc:
        app.logger.warning("AI network error: %s", exc)
        return err(502, "ai_network", "Could not reach the AI service. Check your internet connection or try another network.")
    except (AttributeError, ValueError):
        return err(502, "ai_parse", "The AI reply could not be read. Try again.")
    items = clean_items(result.get("items"))
    severity = result.get("severity") if result.get("severity") in ("none", "low", "medium", "high") else "low"
    summary = text(result.get("summary"), 300)
    tips = [text(s, 200) for s in (result.get("suggestions") or [])[:6] if isinstance(s, str)]
    did = save_detection(d, "AI", items, severity, summary) if items else None
    return jsonify(id=did, items=items, severity=severity, summary=summary, suggestions=tips)


# ---------- contact ----------
@app.post("/api/contact")
def contact():
    d = body()
    name, email, msg = text(d.get("name"), 80), text(d.get("email"), 120), text(d.get("message"), 2000)
    if len(name) < 2 or not EMAIL_RE.match(email) or len(msg) < 10:
        return err(400, "invalid", "Enter your name, a valid email and a message of at least 10 characters.")
    db().execute("INSERT INTO messages(name,email,message,created_at) VALUES(?,?,?,?)", (name, email, msg, now_ms()))
    db().commit()
    return jsonify(ok=True), 201


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))