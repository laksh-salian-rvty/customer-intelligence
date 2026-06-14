import json
import os
import unittest
from unittest.mock import Mock, patch
import requests

os.environ["SKIP_DATABRICKS_INIT"] = "1"

import main


class FakeWorkspaceClient:
    class Config:
        host = "https://example.databricks.local"

        @staticmethod
        def authenticate():
            return {"Authorization": "Bearer test-token"}

    config = Config()


class FakeStreamingResponse:
    def __init__(self, lines, status_code=200, text=""):
        self.lines = lines
        self.status_code = status_code
        self.ok = 200 <= status_code < 400
        self.text = text
        self.headers = {"Content-Type": "text/event-stream"}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def iter_lines(self, decode_unicode=True):
        yield from self.lines

    def raise_for_status(self):
        raise requests.HTTPError(f"{self.status_code} Server Error")


class BrokenStreamingResponse(FakeStreamingResponse):
    def __init__(self):
        super().__init__([])

    def iter_lines(self, decode_unicode=True):
        raise AttributeError("'NoneType' object has no attribute 'readline'")
        yield


def sse_payload(raw_event):
    return json.loads(raw_event.removeprefix("data: ").strip())


def collect_data_events(chunks):
    events = []
    for chunk in chunks:
        text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
        for frame in text.split("\n\n"):
            if frame.startswith("data: "):
                events.append(sse_payload(frame))
    return events


class ChatSSEStreamingTest(unittest.TestCase):
    def test_chat_stream_starts_with_proxy_flush_padding(self):
        def fake_agent_stream(_messages):
            yield main._sse_event({
                "type": "done",
                "data": {"answer": "ok", "follow_ups": [], "routing": None, "trace": []},
            })

        client = main.app.test_client()
        payload = {"messages": [{"role": "user", "content": "show customer churn risk"}]}

        with patch.object(main, "_stream_agent_endpoint", fake_agent_stream):
            response = client.post("/api/chat", json=payload, buffered=False)
            chunks = response.response
            first_chunk = next(chunks).decode("utf-8")
            second_chunk = next(chunks).decode("utf-8")

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["Content-Type"])
        self.assertNotIn("Transfer-Encoding", response.headers)
        self.assertTrue(first_chunk.startswith(":"))
        self.assertGreaterEqual(len(first_chunk), main.SSE_FLUSH_PADDING_BYTES)
        self.assertEqual(
            json.loads(second_chunk.removeprefix("data: ").strip())["type"],
            "status",
        )

    def test_stream_uses_completed_response_output_when_item_events_are_missing(self):
        completed = {
            "type": "response.completed",
            "response": {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": '{"answer":"stream answer","follow_ups":[]}'}
                        ],
                    }
                ],
            },
        }
        fake_response = FakeStreamingResponse([f"data: {json.dumps(completed)}"])

        with (
            patch.object(main, "_workspace_client", FakeWorkspaceClient()),
            patch.object(main, "_host", "https://example.databricks.local"),
            patch.object(main.requests, "post", return_value=fake_response),
        ):
            events = [
                sse_payload(event)
                for event in main._stream_agent_endpoint([{"role": "user", "content": "hello"}])
                if event.startswith("data: ")
            ]

        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["data"]["answer"], "stream answer")

    def test_streaming_gateway_error_uses_synchronous_fallback(self):
        fake_response = FakeStreamingResponse([], status_code=502)
        fallback_payload = {
            "custom_outputs": {
                "final_response": '{"answer":"fallback answer","follow_ups":[]}'
            }
        }

        with (
            patch.object(main, "_workspace_client", FakeWorkspaceClient()),
            patch.object(main, "_host", "https://example.databricks.local"),
            patch.object(main.requests, "post", return_value=fake_response),
            patch.object(main, "_call_agent_endpoint", return_value=fallback_payload),
        ):
            events = [
                sse_payload(event)
                for event in main._stream_agent_endpoint([{"role": "user", "content": "hello"}])
                if event.startswith("data: ")
            ]

        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["data"]["answer"], "fallback answer")

    def test_reader_failure_ends_chat_stream_without_starting_second_agent_run(self):
        fake_response = BrokenStreamingResponse()
        fallback = Mock(return_value={
            "custom_outputs": {
                "final_response": '{"answer":"second run answer","follow_ups":[]}'
            }
        })

        client = main.app.test_client()
        payload = {"messages": [{"role": "user", "content": "summarize customer"}]}

        with (
            patch.object(main, "_workspace_client", FakeWorkspaceClient()),
            patch.object(main, "_host", "https://example.databricks.local"),
            patch.object(main.requests, "post", return_value=fake_response),
            patch.object(main, "_call_agent_endpoint", fallback),
        ):
            response = client.post("/api/chat", json=payload, buffered=False)
            events = collect_data_events(response.response)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("response stream disconnected", events[-1]["message"])
        fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
