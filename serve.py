#!/usr/bin/env python3
"""imgnote local server.

Serves the imgnote single-page app (static assets in ./public, next to this
file) and a small JSON API over a folder of images:

    GET  /              app shell (public/index.html)
    GET  /<asset>        static asset from public/ (app.js, drag.js, style.css, ...)
    GET  /files          {"files": [...], "layout": {...}|null}
    GET  /img/<name>      raw bytes of one image, sandboxed to the served folder
    POST /layout          write the board layout to <folder>/.imgnote.json
    POST /import          write sliced clipboard images into the folder as new files

Standard library only. Binds to 127.0.0.1 exclusively -- this is a local tool,
never meant to be reachable from the network.

Usage:
    python3 serve.py <folder> [--port 5173]
"""

from __future__ import annotations

import argparse
import base64
import errno
import json
import mimetypes
import os
import re
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

# Extensions imgnote will list, serve and treat as images. Case-insensitive.
ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico",
}

# mimetypes' built-in database is inconsistent across platforms for some of
# these, so pin the ones the spec cares about explicitly. Also covers the
# handful of static asset types served out of public/.
EXTRA_CONTENT_TYPES = {
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
}

MAX_LAYOUT_BYTES = 10 * 1024 * 1024  # 10 MB cap on POST /layout bodies
MAX_IMPORT_BYTES = 64 * 1024 * 1024  # 64 MB cap on POST /import bodies (base64 inflates ~4/3)
MAX_IMPORT_FILES = 512               # cap on slices written by one import
LAYOUT_FILENAME = ".imgnote.json"

# Filenames the importer will accept, before the extension is checked
# separately. Deliberately strict: no separators, no leading dot, no control
# characters, nothing that could escape the folder or shadow a dotfile.
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$")

# Leading bytes an imported file must carry for its claimed extension. The
# importer only ever receives images the browser encoded, so a mismatch means
# the request did not come from the app.
IMAGE_SIGNATURES = {
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],
}

# public/ lives next to this script, not the cwd, so `python3 serve.py`
# works regardless of where it's invoked from.
SERVER_ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = SERVER_ROOT / "public"


def guess_content_type(path: Path) -> str:
    """Resolve a Content-Type for a file, preferring our explicit map."""
    ext = path.suffix.lower()
    if ext in EXTRA_CONTENT_TYPES:
        return EXTRA_CONTENT_TYPES[ext]
    content_type, _ = mimetypes.guess_type(str(path))
    return content_type or "application/octet-stream"


def list_image_files(folder: Path) -> list[dict[str, object]]:
    """Flat (non-recursive) listing of allowed image files in `folder`.

    Skips dotfiles, directories, and anything outside the extension
    allowlist. Sorted by name, case-insensitively.
    """
    entries: list[dict[str, object]] = []
    for entry in folder.iterdir():
        if entry.name.startswith("."):
            continue
        if entry.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        if not entry.is_file():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        entries.append({"name": entry.name, "size": stat.st_size, "mtime": stat.st_mtime})
    entries.sort(key=lambda e: str(e["name"]).casefold())
    return entries


def load_layout(folder: Path) -> dict | None:
    """Return the parsed `.imgnote.json`, or None if absent/unparseable."""
    layout_path = folder / LAYOUT_FILENAME
    if not layout_path.is_file():
        return None
    try:
        with layout_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def unique_name(folder: Path, name: str) -> str:
    """Return `name`, or `stem-2.ext`, `stem-3.ext`, ... if it is taken.

    Importing only ever *adds* files. An existing image is never overwritten,
    so a board that references `cat.png` keeps pointing at the same bytes.
    """
    candidate = folder / name
    if not candidate.exists():
        return name
    stem, ext = os.path.splitext(name)
    for n in range(2, 1000):
        alt = f"{stem}-{n}{ext}"
        if not (folder / alt).exists():
            return alt
    raise OSError(f"could not find a free filename for {name}")


def decode_import_entry(entry: object) -> tuple[str, bytes]:
    """Validate one {"name", "data"} import entry -> (name, raw bytes).

    Raises ValueError with a user-facing message on anything suspicious.
    """
    if not isinstance(entry, dict):
        raise ValueError("each file must be an object with 'name' and 'data'.")
    name = entry.get("name")
    data = entry.get("data")
    if not isinstance(name, str) or not isinstance(data, str):
        raise ValueError("'name' and 'data' must both be strings.")
    if not SAFE_NAME_RE.match(name):
        raise ValueError(f"unsafe filename: {name!r}")
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"disallowed extension: {name!r}")
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"{name}: invalid base64 ({exc})") from exc
    if not raw:
        raise ValueError(f"{name}: empty file")
    signatures = IMAGE_SIGNATURES.get(ext)
    if signatures and not any(raw.startswith(sig) for sig in signatures):
        raise ValueError(f"{name}: content is not a valid {ext[1:]} image")
    return name, raw


class ImgNoteServer(ThreadingHTTPServer):
    """HTTPServer carrying the resolved image folder for handlers to use."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], handler_cls: type[BaseHTTPRequestHandler], image_dir: Path) -> None:
        self.image_dir = image_dir
        super().__init__(server_address, handler_cls)


class ImgNoteHandler(BaseHTTPRequestHandler):
    """Routes GET/POST requests for the imgnote app and API."""

    server_version = "imgnote/1.0"
    protocol_version = "HTTP/1.1"

    server: ImgNoteServer

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        # Quiet by design: no per-request stderr noise. See main() for the
        # one-time startup banner instead.
        pass

    # -- response helpers --------------------------------------------------

    def _send_bytes(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status: HTTPStatus, text: str) -> None:
        self._send_bytes(status, text.encode("utf-8"), "text/plain; charset=utf-8")

    def _send_json(self, status: HTTPStatus, payload: dict) -> None:
        self._send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _send_file(self, path: Path, content_type: str | None = None) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self._send_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return
        self._send_bytes(HTTPStatus.OK, data, content_type or guess_content_type(path))

    # -- path safety ---------------------------------------------------------

    def _resolve_static_asset(self, raw_path: str) -> Path | None:
        """Map a request path to a file directly inside PUBLIC_DIR, or None."""
        decoded = unquote(raw_path)
        if not decoded:
            return None
        try:
            resolved = (PUBLIC_DIR / decoded).resolve()
            public_resolved = PUBLIC_DIR.resolve()
        except OSError:
            return None
        if resolved.parent != public_resolved:
            return None
        if not resolved.is_file():
            return None
        return resolved

    def _resolve_image(self, raw_name: str) -> Path | None:
        """Map an /img/<name> request to a file directly inside the image
        folder, rejecting traversal, symlinks-out, and disallowed
        extensions. Returns None (-> 404) on any doubt.
        """
        decoded = unquote(raw_name)
        if not decoded:
            return None
        try:
            resolved = (self.server.image_dir / decoded).resolve()
            image_dir_resolved = self.server.image_dir.resolve()
        except OSError:
            return None
        if resolved.parent != image_dir_resolved:
            return None
        if resolved.name.startswith("."):
            # Dotfiles are excluded from /files, so they are not addressable here
            # either -- notably .imgnote.json's siblings and editor backups.
            return None
        if resolved.suffix.lower() not in ALLOWED_EXTENSIONS:
            return None
        if not resolved.is_file():
            return None
        return resolved

    # -- routing -------------------------------------------------------------

    def do_GET(self) -> None:
        path = urlsplit(self.path).path

        if path == "/":
            self._handle_index()
        elif path == "/files":
            self._handle_files()
        elif path.startswith("/img/"):
            self._handle_img(path[len("/img/"):])
        else:
            self._handle_static(path)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/layout":
            self._handle_layout()
        elif path == "/import":
            self._handle_import()
        else:
            self._send_text(HTTPStatus.NOT_FOUND, "404 Not Found")

    # -- handlers --------------------------------------------------------

    def _handle_index(self) -> None:
        index_path = PUBLIC_DIR / "index.html"
        if not index_path.is_file():
            self._send_text(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "503 Service Unavailable: public/index.html does not exist yet.",
            )
            return
        self._send_file(index_path, "text/html; charset=utf-8")

    def _handle_static(self, path: str) -> None:
        resolved = self._resolve_static_asset(path.lstrip("/"))
        if resolved is None:
            self._send_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return
        self._send_file(resolved)

    def _handle_files(self) -> None:
        files = list_image_files(self.server.image_dir)
        layout = load_layout(self.server.image_dir)
        self._send_json(HTTPStatus.OK, {"files": files, "layout": layout})

    def _handle_img(self, raw_name: str) -> None:
        resolved = self._resolve_image(raw_name)
        if resolved is None:
            self._send_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return
        self._send_file(resolved)

    def _read_json_object(self, max_bytes: int) -> dict | None:
        """Read and parse a JSON object body, or send an error and return None.

        Every failure path here sets `close_connection`: with keep-alive on, a
        body we refused to read would otherwise be parsed as the next request.
        """
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self.close_connection = True
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Missing Content-Length header."})
            return None
        try:
            length = int(length_header)
        except ValueError:
            self.close_connection = True
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid Content-Length header."})
            return None
        if length < 0 or length > max_bytes:
            self.close_connection = True
            self._send_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"ok": False, "error": f"Body too large (max {max_bytes} bytes)."},
            )
            return None

        try:
            raw_body = self.rfile.read(length)
        except OSError as exc:
            self.close_connection = True
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Failed to read request body: {exc}"})
            return None

        try:
            data = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Invalid JSON: {exc}"})
            return None

        if not isinstance(data, dict):
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object."})
            return None
        return data

    def _handle_layout(self) -> None:
        data = self._read_json_object(MAX_LAYOUT_BYTES)
        if data is None:
            return

        image_dir = self.server.image_dir
        layout_path = image_dir / LAYOUT_FILENAME
        tmp_path = image_dir / f"{LAYOUT_FILENAME}.tmp"
        try:
            with tmp_path.open("w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp_path, layout_path)
        except OSError as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"Failed to write layout: {exc}"})
            return

        self._send_json(HTTPStatus.OK, {"ok": True})

    def _handle_import(self) -> None:
        """Write base64 image slices into the served folder as new files.

        Body: {"files": [{"name": "cat.png", "data": "<base64>"}, ...]}

        Every entry is validated and decoded *before* anything touches the
        disk, so a malformed request writes nothing at all. Names that are
        already taken -- on disk or earlier in the same batch -- are given a
        `-2`, `-3`, ... suffix; an existing file is never overwritten.
        """
        data = self._read_json_object(MAX_IMPORT_BYTES)
        if data is None:
            return

        entries = data.get("files")
        if not isinstance(entries, list) or not entries:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "No files to import."})
            return
        if len(entries) > MAX_IMPORT_FILES:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": f"Too many slices ({len(entries)}, max {MAX_IMPORT_FILES})."},
            )
            return

        try:
            decoded = [decode_import_entry(entry) for entry in entries]
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        image_dir = self.server.image_dir
        image_dir_resolved = image_dir.resolve()
        written: list[str] = []
        taken: set[str] = set()
        try:
            for name, raw in decoded:
                final = unique_name(image_dir, name)
                # `unique_name` only looks at the disk, so a batch containing
                # the same name twice would otherwise resolve both to it.
                while final.casefold() in taken:
                    stem, ext = os.path.splitext(final)
                    final = unique_name(image_dir, f"{stem}-2{ext}")
                taken.add(final.casefold())

                target = (image_dir / final).resolve()
                if target.parent != image_dir_resolved:
                    raise OSError(f"refusing to write outside the folder: {final}")

                tmp_path = image_dir / f".{final}.imgnote-tmp"
                with tmp_path.open("wb") as f:
                    f.write(raw)
                os.replace(tmp_path, target)
                written.append(final)
        except OSError as exc:
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": f"Failed to write slices: {exc}", "written": written},
            )
            return

        self._send_json(HTTPStatus.OK, {"ok": True, "written": written})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="serve.py",
        description="Serve a folder of images for the imgnote board.",
    )
    parser.add_argument("folder", help="Path to the folder of images to serve.")
    parser.add_argument("--port", type=int, default=5173, help="Port to listen on (default: 5173).")
    return parser.parse_args(argv)


def translate_windows_path(raw: str) -> Path | None:
    """Map a Windows-style path onto its WSL mount point, or None.

    Pasting `C:\\Users\\me\\icons` into a WSL shell is the most common way to
    start this server with a path the kernel cannot see. Translate the drive
    form to /mnt/<drive>/... so it just works; UNC paths have no such mapping.
    """
    if re.match(r"^[A-Za-z]:[\\/]", raw):
        drive, rest = raw[0].lower(), raw[2:]
        return Path("/mnt") / drive / rest.replace("\\", "/").lstrip("/")
    return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    folder = Path(args.folder)
    if not folder.exists():
        translated = translate_windows_path(args.folder)
        if translated is not None and translated.is_dir():
            print(f"note: reading {args.folder} as {translated}", file=sys.stderr)
            folder = translated
        else:
            print(f"error: folder does not exist: {args.folder}", file=sys.stderr)
            if translated is not None:
                print(f"       under WSL, try the mounted path: {translated}", file=sys.stderr)
            elif args.folder.startswith("\\\\"):
                print("       UNC paths are not readable from WSL; use a /mnt/<drive>/... path "
                      "or a path inside the Linux filesystem.", file=sys.stderr)
            return 1
    if not folder.is_dir():
        print(f"error: not a directory: {folder}", file=sys.stderr)
        return 1
    image_dir = folder.resolve()

    if not PUBLIC_DIR.is_dir():
        print(
            f"warning: {PUBLIC_DIR} does not exist yet; GET / will return 503 until it does.",
            file=sys.stderr,
        )

    try:
        server = ImgNoteServer(("127.0.0.1", args.port), ImgNoteHandler, image_dir)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(f"error: port {args.port} is already in use. Pick another with --port.", file=sys.stderr)
        else:
            print(f"error: could not bind 127.0.0.1:{args.port}: {exc}", file=sys.stderr)
        return 1

    file_count = len(list_image_files(image_dir))
    url = f"http://127.0.0.1:{args.port}/"
    print("imgnote", flush=True)
    print(f"  folder: {image_dir}", flush=True)
    print(f"  images: {file_count}", flush=True)
    print(f"  url:    {url}", flush=True)
    print("  (Ctrl+C to stop)", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
