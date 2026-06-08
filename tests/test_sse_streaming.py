import json
import os
import unittest
from unittest.mock import patch

os.environ["SKIP_DATABRICKS_INIT"] = "1"

import main


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


if __name__ == "__main__":
    unittest.main()
