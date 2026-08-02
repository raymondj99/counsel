"""HTTP sidecar for tree-guided live mediation (consumed by server.js)."""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from mediation.config import ensure_env_file, load_settings  # noqa: E402
from live.cases import list_cases, resolve_tree_path  # noqa: E402
from live.live_mediator import LiveMediator  # noqa: E402

DEFAULT_PORT = 3001

_mediator: LiveMediator | None = None
_tree_path: Path | None = None
_case_name: str | None = None


class MediatorHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            payload = {"ok": True, "mediator_ready": _mediator is not None}
            if _tree_path is not None:
                payload["tree_file"] = str(_tree_path)
            if _case_name:
                payload["case"] = _case_name
            if _mediator is not None:
                payload.update(_mediator.snapshot())
            self._write_json(payload)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/mediator/consider":
            self.send_error(404)
            return
        if _mediator is None:
            self._write_json({"error": "Mediator not initialized"}, status=503)
            return

        try:
            body = self._read_json()
        except json.JSONDecodeError:
            self._write_json({"error": "Invalid JSON body"}, status=400)
            return

        transcript = body.get("transcript") or []
        if not isinstance(transcript, list):
            self._write_json({"error": "transcript must be a list of strings"}, status=400)
            return

        result = _mediator.consider([str(line) for line in transcript])
        self._write_json(result)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode() or "{}")

    def _write_json(self, payload: dict, *, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    global _mediator, _tree_path, _case_name

    ensure_env_file()
    settings = load_settings()

    available = ", ".join(list_cases()) or "case1"
    parser = argparse.ArgumentParser(description="Tree-guided mediation sidecar")
    parser.add_argument(
        "--case",
        help=f"Case folder under live/cases/ (available: {available})",
    )
    parser.add_argument(
        "--tree",
        help="Path to simulated_conversation_tree.json (overrides --case)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("MEDIATOR_PORT", str(DEFAULT_PORT))),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log prompts but skip Inworld API calls (uses tree template as speech)",
    )
    args = parser.parse_args()

    tree_path, case_name = resolve_tree_path(
        case=args.case,
        tree=args.tree,
        repo_root=REPO_ROOT,
    )
    if not tree_path.is_file():
        hint = f"python mediation/demo.py --case {case_name}" if case_name else "python mediation/demo.py --case <name>"
        raise SystemExit(
            f"Conversation tree not found: {tree_path}\n"
            f"Generate it first:\n  {hint}"
        )

    _tree_path = tree_path
    _case_name = case_name

    dry_run = args.dry_run or os.getenv("MEDIATOR_DRY_RUN") == "1"
    if not dry_run and not settings.inworld_api_key:
        print("INWORLD_API_KEY missing — starting in dry-run mode.")
        dry_run = True

    _mediator = LiveMediator.from_tree_file(tree_path, settings, dry_run=dry_run)
    snapshot = _mediator.snapshot()
    if case_name:
        print(f"Case: {case_name}")
    print(f"Loaded tree from {tree_path}")
    if dry_run:
        print("DRY-RUN: prompts logged; tree templates spoken (no Inworld LLM).")
    print(
        f"Session: {snapshot['user1']} & {snapshot['user2']} — "
        f"P={snapshot.get('success_probability')}"
    )
    print(f"Mediator sidecar listening on http://127.0.0.1:{args.port}")

    HTTPServer(("127.0.0.1", args.port), MediatorHandler).serve_forever()


if __name__ == "__main__":
    main()
