import json
import mimetypes
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PORT = int(os.environ.get("BUFFERED_UI_TEST_PORT", "4174"))


class BufferedUIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length") or "0")
        if length:
            self.rfile.read(length)

        time.sleep(3)
        done_payload = {
            "type": "done",
            "data": {
                "answer": "Buffered response complete.",
                "follow_ups": [],
                "routing": {"selected_agent": "Order Cancellation Prediction"},
                "trace": [],
            },
        }
        body = (
            'data: {"type":"status","message":"Analyzing your query..."}\n\n'
            'data: {"type":"routing","agents":["Order Cancellation Prediction"]}\n\n'
            f"data: {json.dumps(done_payload)}\n\n"
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        requested = self.path.split("?", 1)[0].lstrip("/")
        path = DIST / requested
        if requested and path.exists() and path.is_file():
            content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        index = DIST / "index.html"
        data = index.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    if not DIST.exists():
        raise SystemExit("dist does not exist. Run npm run build first.")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), BufferedUIHandler)
    print(f"Buffered UI test server running at http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
