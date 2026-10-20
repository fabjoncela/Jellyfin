#!/usr/bin/env python3
"""Private Jellyfin-to-Lingarr translation request companion."""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from contextlib import contextmanager

PORT = int(os.environ.get("PORT", "8080"))
JELLYFIN_URL = os.environ.get("JELLYFIN_URL", "http://jellyfin:8096").rstrip("/")
LINGARR_URL = os.environ.get("LINGARR_URL", "http://lingarr:9876").rstrip("/")
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", "/media")).resolve()
LINGARR_MEDIA_ROOT = os.environ.get("LINGARR_MEDIA_ROOT", "/data/media").rstrip("/")
STATE_DB = os.environ.get("STATE_DB", "/state/requests.sqlite3")
SESSION_COOKIE = "__Host-lingarr_request_session"
SESSION_TTL = 8 * 60 * 60
ALLOWED_TARGETS = {"it": "Italian", "sq": "Albanian"}
ALLOWED_MEDIA_TYPES = {"Movie", "Episode"}
MAX_BODY = 32_768

_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()
_worker_locks: dict[str, threading.Lock] = {}
_worker_locks_lock = threading.Lock()
_login_failures: dict[str, list[float]] = {}
_login_failures_lock = threading.Lock()


def db_connect():
    conn = sqlite3.connect(STATE_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


@contextmanager
def db():
    conn = db_connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    Path(STATE_DB).parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            item_title TEXT NOT NULL,
            media_type TEXT NOT NULL,
            source_path TEXT NOT NULL,
            target_code TEXT NOT NULL,
            status TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            lingarr_job_id TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )""")
        conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS requests_active_key
            ON requests(source_path, target_code)
            WHERE status IN ('accepted','resolving','syncing','queued','processing')""")
        conn.execute("CREATE INDEX IF NOT EXISTS requests_status_idx ON requests(status)")


def upstream(method: str, url: str, payload=None, token: str | None = None, headers=None, timeout=15):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req_headers = {"Accept": "application/json"}
    if body is not None:
        req_headers["Content-Type"] = "application/json"
    if token:
        req_headers["X-Emby-Token"] = token
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read(2_000_000)
            if not raw:
                return response.status, None
            content_type = response.headers.get("Content-Type", "")
            if "json" in content_type.lower() or raw[:1] in (b"{", b"["):
                return response.status, json.loads(raw.decode("utf-8"))
            return response.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read(32_768)
        try:
            data = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:
            data = None
        return exc.code, data
    except Exception as exc:
        raise RuntimeError(type(exc).__name__) from None


def jellyfin_auth_header():
    return {
        "X-Emby-Authorization": (
            'MediaBrowser Client="Lingarr Requests", Device="PWA", '
            'DeviceId="lingarr-requests-pwa", Version="1.0.0"'
        )
    }


def get_session(handler):
    cookie = handler.headers.get("Cookie", "")
    sid = ""
    for part in cookie.split(";"):
        key, _, value = part.strip().partition("=")
        if key == SESSION_COOKIE:
            sid = value
            break
    if not sid:
        return None
    with _sessions_lock:
        session = _sessions.get(sid)
        if not session or session["expires"] < time.time():
            _sessions.pop(sid, None)
            return None
        session["expires"] = time.time() + SESSION_TTL
        return dict(session)


def jellyfin_request(session, path, query=None):
    url = f"{JELLYFIN_URL}/{path.lstrip('/')}"
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    status, data = upstream("GET", url, token=session["token"])
    if status == 401:
        raise PermissionError("Jellyfin sign-in expired")
    if status < 200 or status >= 300:
        raise RuntimeError(f"Jellyfin returned HTTP {status}")
    return data


def lingarr_request(method, path, payload=None):
    status, data = upstream(method, f"{LINGARR_URL}/{path.lstrip('/')}", payload)
    if status < 200 or status >= 300:
        raise RuntimeError(f"Lingarr returned HTTP {status}")
    return data


def item_from_jellyfin(session, item_id):
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", item_id):
        raise ValueError("Invalid Jellyfin item ID")
    item = jellyfin_request(
        session,
        f"Users/{urllib.parse.quote(session['user_id'])}/Items/{urllib.parse.quote(item_id)}",
        {"Fields": "Path,MediaSources,ProviderIds"},
    )
    if not isinstance(item, dict) or item.get("Id") != item_id:
        raise ValueError("Jellyfin item was not found for this account")
    if item.get("Type") not in ALLOWED_MEDIA_TYPES:
        raise ValueError("Choose one movie or one episode")
    return item


def resolve_media_path(item):
    raw = item.get("Path")
    if not raw:
        for source in item.get("MediaSources") or []:
            if source.get("Path"):
                raw = source["Path"]
                break
    if not raw:
        raise ValueError("Jellyfin did not provide a local media path")
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise ValueError("Jellyfin returned a non-local media path")
    try:
        resolved = candidate.resolve(strict=False)
        relative = resolved.relative_to(MEDIA_ROOT)
    except (OSError, ValueError):
        raise ValueError("Selected media is outside the configured media library") from None
    return resolved, relative, resolved.is_file()


def subtitle_paths(video_path):
    base = video_path.with_suffix("")
    return {
        "en": Path(str(base) + ".en.srt"),
        "it": Path(str(base) + ".it.srt"),
        "sq": Path(str(base) + ".sq.srt"),
    }


def sidecar_is_file(path):
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(MEDIA_ROOT)
        return resolved.is_file()
    except (OSError, ValueError):
        return False


def safe_output_target(path):
    try:
        resolved = path.resolve(strict=False)
        resolved.relative_to(MEDIA_ROOT)
        return not path.is_symlink()
    except (OSError, ValueError):
        return False


def lingarr_path(relative: Path):
    return f"{LINGARR_MEDIA_ROOT}/{relative.as_posix()}"


def norm_path(value):
    if not isinstance(value, str) or not value:
        return None
    value = value.replace("\\", "/")
    prefix = LINGARR_MEDIA_ROOT + "/"
    if value.startswith(prefix):
        return value[len(prefix):].casefold()
    host_prefix = str(MEDIA_ROOT).rstrip("/") + "/"
    if value.startswith(host_prefix):
        return value[len(host_prefix):].casefold()
    if value.startswith("/media/"):
        return value[len("/media/"):].casefold()
    return None


def find_lingarr_translation_history(title, source_rel):
    """Return completed Lingarr records for this exact English subtitle path."""
    completed = {}
    for page in range(1, 6):
        query = urllib.parse.urlencode({
            "pageNumber": page,
            "searchQuery": title,
            "orderBy": "date",
            "ascending": "false",
        })
        result = lingarr_request("GET", f"api/translationRequest/requests?{query}")
        if not isinstance(result, dict):
            break
        for request in result.get("items") or []:
            if not isinstance(request, dict):
                continue
            if norm_path(request.get("subtitleToTranslate")) != source_rel.casefold():
                continue
            target = str(request.get("targetLanguage", "")).casefold()
            state = str(request.get("status", "")).casefold()
            if target in ALLOWED_TARGETS and state in {"completed", "succeeded", "success"}:
                completed.setdefault(target, str(request.get("completedAt") or ""))
        total = int(result.get("totalCount") or 0)
        page_size = int(result.get("pageSize") or max(1, len(result.get("items") or [])))
        if not result.get("items") or page * page_size >= total:
            break
    return [{"target": target, "completedAt": completed[target]} for target in ALLOWED_TARGETS if target in completed]


def find_lingarr_media(media_type, title, desired_rel):
    endpoint = "movies" if media_type == "Movie" else "shows"
    for page in range(1, 101):
        query = urllib.parse.urlencode({
            "pageNumber": page,
            "searchQuery": title,
            "orderBy": "title",
            "ascending": "true",
        })
        result = lingarr_request("GET", f"api/media/{endpoint}?{query}")
        if not isinstance(result, dict):
            return None
        items = result.get("items") or []
        found = find_media_node(items, desired_rel)
        if found:
            return found
        total = int(result.get("totalCount") or 0)
        page_size = int(result.get("pageSize") or max(1, len(items)))
        if not items or page * page_size >= total:
            break
    return None


def find_media_node(node, desired_rel):
    if isinstance(node, list):
        for value in node:
            found = find_media_node(value, desired_rel)
            if found:
                return found
        return None
    if not isinstance(node, dict):
        return None
    path_values = []
    for key, value in node.items():
        if key.casefold() in {"path", "filepath", "moviepath", "episodepath"}:
            normalized = norm_path(value)
            if normalized:
                path_values.append(normalized)
    if desired_rel.casefold() in path_values and node.get("id") is not None:
        return node
    for value in node.values():
        found = find_media_node(value, desired_rel)
        if found:
            return found
    return None


def write_request(req_id, **fields):
    fields["updated_at"] = int(time.time())
    assignments = ",".join(f"{name}=?" for name in fields)
    values = list(fields.values()) + [req_id]
    with db() as conn:
        conn.execute(f"UPDATE requests SET {assignments} WHERE id=?", values)


def request_row(req_id, user_id):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM requests WHERE id=? AND user_id=?", (req_id, user_id)
        ).fetchone()
        return dict(row) if row else None


def worker_lock(key):
    with _worker_locks_lock:
        return _worker_locks.setdefault(key, threading.Lock())


def scheduled_job_running(job_id):
    jobs = lingarr_request("GET", "api/schedule/jobs")
    for job in jobs if isinstance(jobs, list) else []:
        if job.get("id") == job_id:
            return bool(job.get("isCurrentlyRunning"))
    return False


def process_request(req_id, session):
    row = request_row(req_id, session["user_id"])
    if not row:
        return
    with worker_lock("lingarr-single-submit"):
        try:
            write_request(req_id, status="resolving", message="Checking Lingarr's library")
            item = item_from_jellyfin(session, row["item_id"])
            video_path, rel, media_available = resolve_media_path(item)
            if not media_available:
                write_request(req_id, status="failed", message="The video file is missing from the media folder; no new translation was queued.")
                return
            paths = subtitle_paths(video_path)
            source = paths["en"]
            if not sidecar_is_file(source):
                write_request(req_id, status="failed", message="No English .en.srt subtitle file found. Get one with Bazarr first.")
                return
            target = row["target_code"]
            target_path = paths[target]
            if not safe_output_target(target_path):
                write_request(req_id, status="failed", message="The target subtitle path is not safe to write.")
                return
            if target_path.exists():
                write_request(req_id, status="already_exists", message=f"{ALLOWED_TARGETS[target]} subtitle already exists.")
                return

            media = find_lingarr_media(row["media_type"], row["item_title"], rel.as_posix())
            if not media:
                job_id = "SyncMovieJob" if row["media_type"] == "Movie" else "SyncShowJob"
                if not scheduled_job_running(job_id):
                    result = lingarr_request("POST", "api/schedule/job/start", {"jobName": job_id})
                    # Retain only a non-secret upstream identifier if present.
                    job_ref = str(result.get("jobId", ""))[:80] if isinstance(result, dict) else ""
                    write_request(req_id, status="syncing", message="Running the one-time library sync before queueing this item.", lingarr_job_id=job_ref)
                else:
                    write_request(req_id, status="syncing", message="Waiting for the current library sync before queueing this item.")
                deadline = time.monotonic() + 240
                while time.monotonic() < deadline:
                    time.sleep(4)
                    if not scheduled_job_running(job_id):
                        media = find_lingarr_media(row["media_type"], row["item_title"], rel.as_posix())
                        if media:
                            break
                if not media:
                    write_request(req_id, status="failed", message="Lingarr did not index this item yet. Wait for its library sync to finish, then try again.")
                    return

            source_lingarr = lingarr_path(rel.with_name(source.name))
            result = lingarr_request("POST", "api/translate/file", {
                "mediaId": media["id"],
                "subtitlePath": source_lingarr,
                "subtitleFormat": "srt",
                "sourceLanguage": "en",
                "targetLanguage": target,
                "mediaType": row["media_type"],
            })
            job_id = str(result.get("jobId", "")) if isinstance(result, dict) else ""
            if not job_id:
                write_request(req_id, status="failed", message="Lingarr did not return a job ID, so the request is not confirmed queued.")
                return
            write_request(req_id, status="queued", message="Queued in Lingarr.", lingarr_job_id=job_id)
        except PermissionError:
            write_request(req_id, status="failed", message="Jellyfin sign-in expired. Sign in again and retry.")
        except Exception as exc:
            safe = str(exc)
            if len(safe) > 200:
                safe = safe[:200]
            write_request(req_id, status="failed", message=f"Request stopped: {safe}")


def refresh_status(row):
    if row.get("status") not in {"queued", "processing"} or not row.get("lingarr_job_id"):
        return row
    output_path = subtitle_paths(Path(row["source_path"]))[row["target_code"]]
    if sidecar_is_file(output_path):
        write_request(row["id"], status="completed", message="Translation finished. Refresh this item in Jellyfin if the subtitle has not appeared yet.")
        return request_row(row["id"], row["user_id"])
    try:
        status_code, data = upstream(
            "GET",
            f"{LINGARR_URL}/api/translationRequest/{urllib.parse.quote(row['lingarr_job_id'])}",
        )
        if status_code == 200 and isinstance(data, dict):
            state = str(data.get("status") or data.get("state") or "").casefold()
            if state in {"completed", "succeeded", "success"}:
                write_request(row["id"], status="completed", message="Translation completed. Refresh this item in Jellyfin if the subtitle has not appeared yet.")
            elif state in {"failed", "cancelled", "interrupted"}:
                write_request(row["id"], status="failed", message=f"Lingarr reports this translation {state}.")
            elif state in {"inprogress", "processing", "running"}:
                write_request(row["id"], status="processing", message="Lingarr is translating this subtitle.")
    except Exception:
        pass
    return request_row(row["id"], row["user_id"]) or row


class Handler(BaseHTTPRequestHandler):
    server_version = "LingarrRequests/1.0"
    sys_version = ""

    def log_message(self, _fmt, *_args):
        # Do not log query strings, titles, credentials, or cookies.
        return

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if extra_headers:
            for key, value in extra_headers:
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_BODY:
            raise ValueError("Request is too large")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data

    def require_session(self):
        session = get_session(self)
        if not session:
            self.send_json(401, {"error": "Sign in with your Jellyfin account."})
            return None
        return session

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health":
            return self.send_json(200, {"status": "ok"})
        if path == "/api/session":
            session = self.require_session()
            if session:
                self.send_json(200, {"username": session["username"]})
            return
        if path == "/api/search":
            session = self.require_session()
            if not session:
                return
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0].strip()
            if len(query) < 2 or len(query) > 120:
                return self.send_json(200, {"items": []})
            try:
                data = jellyfin_request(
                    session,
                    f"Users/{urllib.parse.quote(session['user_id'])}/Items",
                    {
                        "SearchTerm": query,
                        "Recursive": "true",
                        "IncludeItemTypes": ["Movie", "Series", "Episode"],
                        "Fields": ["ProductionYear", "Path", "MediaSources", "ProviderIds"],
                        "Limit": 40,
                        "EnableTotalRecordCount": "false",
                    },
                )
                items = []
                for item in (data.get("Items") or [])[:40]:
                    if item.get("Type") not in {"Movie", "Series", "Episode"}:
                        continue
                    items.append({
                        "id": item.get("Id"),
                        "name": item.get("Name", ""),
                        "type": item.get("Type"),
                        "year": item.get("ProductionYear"),
                        "series": item.get("SeriesName", ""),
                        "season": item.get("ParentIndexNumber"),
                        "episode": item.get("IndexNumber"),
                    })
                return self.send_json(200, {"items": items})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})
        if path.startswith("/api/series/") and path.endswith("/episodes"):
            session = self.require_session()
            if not session:
                return
            series_id = path.split("/")[3]
            if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", series_id):
                return self.send_json(400, {"error": "Invalid series ID"})
            try:
                data = jellyfin_request(
                    session,
                    f"Shows/{urllib.parse.quote(series_id)}/Episodes",
                    {"UserId": session["user_id"], "Fields": ["ProductionYear", "Path", "MediaSources"], "IsMissing": "false"},
                )
                items = []
                for item in (data.get("Items") or [])[:500]:
                    items.append({
                        "id": item.get("Id"),
                        "name": item.get("Name", ""),
                        "type": "Episode",
                        "series": item.get("SeriesName", ""),
                        "season": item.get("ParentIndexNumber"),
                        "episode": item.get("IndexNumber"),
                    })
                return self.send_json(200, {"items": items})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})
        if path.startswith("/api/items/") and path.endswith("/inspect"):
            session = self.require_session()
            if not session:
                return
            item_id = path.split("/")[3]
            try:
                result = public_inspection(inspect_item(session, item_id))
                return self.send_json(200, result)
            except ValueError as exc:
                return self.send_json(422, {"error": str(exc)})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})
        if path == "/api/requests":
            session = self.require_session()
            if not session:
                return
            with db() as conn:
                rows = conn.execute(
                    "SELECT * FROM requests WHERE user_id=? ORDER BY updated_at DESC LIMIT 20",
                    (session["user_id"],),
                ).fetchall()
            return self.send_json(200, {"requests": [public_request(refresh_status(dict(row))) for row in rows]})
        if path.startswith("/api/requests/"):
            session = self.require_session()
            if not session:
                return
            request_id = path.rsplit("/", 1)[-1]
            row = request_row(request_id, session["user_id"])
            if not row:
                return self.send_json(404, {"error": "Request not found"})
            row = refresh_status(row)
            return self.send_json(200, public_request(row))
        if path.startswith("/api/"):
            return self.send_json(404, {"error": "Not found"})
        return self.serve_static(path)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlsplit(origin).netloc.casefold() != self.headers.get("Host", "").casefold():
            return self.send_json(403, {"error": "Cross-site requests are not allowed."})
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            return self.send_json(403, {"error": "Cross-site requests are not allowed."})
        try:
            payload = self.read_json()
        except Exception:
            return self.send_json(400, {"error": "Invalid request body"})
        if path == "/api/login":
            username = str(payload.get("username", ""))[:128]
            password = str(payload.get("password", ""))
            if not username or not password or len(password) > 1024:
                return self.send_json(400, {"error": "Enter your Jellyfin username and password."})
            login_key = username.casefold()
            now = time.time()
            with _login_failures_lock:
                recent = [t for t in _login_failures.get(login_key, []) if now - t < 900]
                _login_failures[login_key] = recent
                if len(recent) >= 10:
                    return self.send_json(429, {"error": "Too many sign-in attempts for this account. Wait 15 minutes, then retry."})
            try:
                status, data = upstream(
                    "POST", f"{JELLYFIN_URL}/Users/AuthenticateByName",
                    {"Username": username, "Pw": password}, headers=jellyfin_auth_header(), timeout=20,
                )
                if status < 200 or status >= 300 or not isinstance(data, dict) or not data.get("AccessToken"):
                    with _login_failures_lock:
                        _login_failures.setdefault(login_key, []).append(now)
                    return self.send_json(401, {"error": "Jellyfin sign-in failed. Check the username and password."})
                user = data.get("User") or {}
                sid = secrets.token_urlsafe(32)
                session = {
                    "token": data["AccessToken"],
                    "user_id": str(user.get("Id", "")),
                    "username": str(user.get("Name", username))[:128],
                    "expires": time.time() + SESSION_TTL,
                }
                if not session["user_id"]:
                    return self.send_json(401, {"error": "Jellyfin did not return a user identity."})
                with _sessions_lock:
                    _sessions[sid] = session
                with _login_failures_lock:
                    _login_failures.pop(login_key, None)
                cookie = f"{SESSION_COOKIE}={sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL}"
                return self.send_json(200, {"username": session["username"]}, [("Set-Cookie", cookie)])
            except Exception as exc:
                return self.send_json(502, {"error": f"Could not reach Jellyfin ({type(exc).__name__})."})
        if path == "/api/logout":
            sid = None
            for part in self.headers.get("Cookie", "").split(";"):
                key, _, value = part.strip().partition("=")
                if key == SESSION_COOKIE:
                    sid = value
                    break
            if sid:
                with _sessions_lock:
                    _sessions.pop(sid, None)
            cookie = f"{SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
            return self.send_json(200, {"ok": True}, [("Set-Cookie", cookie)])
        session = self.require_session()
        if not session:
            return
        if path == "/api/inspect":
            item_id = str(payload.get("itemId", ""))
            try:
                return self.send_json(200, public_inspection(inspect_item(session, item_id)))
            except ValueError as exc:
                return self.send_json(422, {"error": str(exc)})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})
        if path == "/api/requests":
            item_id = str(payload.get("itemId", ""))
            targets = payload.get("targets")
            allow_sync = payload.get("allowSync") is True
            if not isinstance(targets, list) or not targets or len(targets) > 2 or any(t not in ALLOWED_TARGETS for t in targets):
                return self.send_json(400, {"error": "Choose Italian, Albanian, or both."})
            try:
                details = inspect_item(session, item_id)
            except ValueError as exc:
                return self.send_json(422, {"error": str(exc)})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})
            if not details["sourceAvailable"]:
                return self.send_json(422, {"error": "No English .en.srt subtitle file found. Get one with Bazarr first."})
            if details["needsSync"] and not allow_sync:
                return self.send_json(409, {"error": "Lingarr has not indexed this item. Confirm the one-time library sync first.", "needsSyncConfirmation": True})
            if any(t in details["unsafeTargets"] for t in targets):
                return self.send_json(409, {"error": "A selected subtitle output path is unsafe; nothing was queued."})
            requested = [t for t in targets if t in details["availableTargets"]]
            if len(requested) != len(targets):
                return self.send_json(409, {"error": "One selected subtitle already exists or changed since inspection. Refresh the item and choose again."})
            try:
                created = []
                now = int(time.time())
                for target in requested:
                    req_id = str(uuid.uuid4())
                    with db() as conn:
                        try:
                            conn.execute(
                                "INSERT INTO requests(id,user_id,item_id,item_title,media_type,source_path,target_code,status,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'accepted','Request accepted',?,?)",
                                (req_id, session["user_id"], item_id, details["title"], details["mediaType"], details["hostPath"], target, now, now),
                            )
                        except sqlite3.IntegrityError:
                            row = conn.execute("SELECT * FROM requests WHERE source_path=? AND target_code=? AND status IN ('accepted','resolving','syncing','queued','processing')", (details["hostPath"], target)).fetchone()
                            if row:
                                if row["user_id"] == session["user_id"]:
                                    created.append(public_request(dict(row)))
                                else:
                                    created.append({"id": "", "title": details["title"], "target": target, "targetName": ALLOWED_TARGETS[target], "status": "queued", "message": "A request for this item is already active."})
                                continue
                            raise
                    thread = threading.Thread(target=process_request, args=(req_id, session), daemon=True)
                    thread.start()
                    created.append({"id": req_id, "title": details["title"], "target": target, "status": "accepted", "message": "Request accepted"})
                return self.send_json(202, {"requests": created})
            except Exception as exc:
                return self.send_json(500, {"error": f"Could not record request ({type(exc).__name__})."})
        return self.send_json(404, {"error": "Not found"})

    def serve_static(self, path):
        if path in ("", "/"):
            relative = "index.html"
        elif path in {"/app.js", "/app.css", "/manifest.webmanifest", "/sw.js", "/icon.svg"}:
            relative = path.lstrip("/")
        else:
            return self.send_json(404, {"error": "Not found"})
        file = Path("/app/public") / relative
        try:
            body = file.read_bytes()
        except OSError:
            return self.send_json(404, {"error": "Not found"})
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".webmanifest": "application/manifest+json",
            ".svg": "image/svg+xml",
        }.get(file.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)


def inspect_item(session, item_id):
    item = item_from_jellyfin(session, item_id)
    video_path, relative, media_available = resolve_media_path(item)
    paths = subtitle_paths(video_path)
    source = paths["en"]
    translation_history = find_lingarr_translation_history(item.get("Name", ""), relative.with_name(source.name).as_posix())
    unsafe_targets = [target for target in ALLOWED_TARGETS if not safe_output_target(paths[target])]
    existing_targets = [target for target in ALLOWED_TARGETS if sidecar_is_file(paths[target])]
    available_targets = [target for target in ALLOWED_TARGETS if target not in unsafe_targets and target not in existing_targets]
    linked = find_lingarr_media(item["Type"], item.get("Name", ""), relative.as_posix())
    return {
        "itemId": item["Id"],
        "title": item.get("Name", ""),
        "type": item["Type"],
        "series": item.get("SeriesName", ""),
        "season": item.get("ParentIndexNumber"),
        "episode": item.get("IndexNumber"),
        "mediaAvailable": media_available,
        "completedTranslations": translation_history,
        "sourceAvailable": sidecar_is_file(source),
        "sourceName": source.name if sidecar_is_file(source) else "",
        "availableTargets": available_targets,
        "existingTargets": existing_targets,
        "unsafeTargets": unsafe_targets,
        "needsSync": linked is None,
        "hostPath": str(video_path),
        "mediaType": item["Type"],
    }


def public_request(row):
    return {
        "id": row["id"],
        "title": row["item_title"],
        "target": row["target_code"],
        "targetName": ALLOWED_TARGETS.get(row["target_code"], row["target_code"]),
        "status": row["status"],
        "message": row["message"],
        "updatedAt": row["updated_at"],
    }


def public_inspection(info):
    return {key: value for key, value in info.items() if key != "hostPath"}


if __name__ == "__main__":
    init_db()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
