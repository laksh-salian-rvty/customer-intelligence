import os
import json
import logging
import ssl
import urllib3
import requests
import time
import threading
from flask import Flask, request, jsonify, send_from_directory, Response
from databricks.sdk import WorkspaceClient

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def _load_dotenv(path=".env"):
    """Load simple KEY=VALUE pairs for local development without an extra dependency."""
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _normalize_databricks_host(host: str) -> str:
    host = host.strip().rstrip("/")
    if host and not host.startswith(("http://", "https://")):
        host = f"https://{host}"
    return host


_load_dotenv()

# ── App ───────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="dist", static_url_path="")


class SSEStreamingMiddleware:
    """WSGI middleware that injects anti-buffering headers for SSE responses.
    Flask/Werkzeug strips hop-by-hop headers, so we add them at the WSGI layer."""

    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        def custom_start_response(status, headers, exc_info=None):
            content_type = dict(headers).get("Content-Type", "")
            if "text/event-stream" in content_type:
                # Remove any Content-Length (incompatible with chunked)
                headers = [(k, v) for k, v in headers if k.lower() != "content-length"]
                # Add anti-buffering headers for all layers
                headers.append(("Transfer-Encoding", "chunked"))
                headers.append(("Cache-Control", "no-cache, no-store, must-revalidate"))
                headers.append(("X-Accel-Buffering", "no"))        # Nginx
                headers.append(("X-Content-Type-Options", "nosniff"))
            return start_response(status, headers, exc_info)

        return self.app(environ, custom_start_response)


app.wsgi_app = SSEStreamingMiddleware(app.wsgi_app)

# ── Config ────────────────────────────────────────────────────────────────────
SERVING_ENDPOINT = os.environ.get("SERVING_ENDPOINT", "mas-15aee8a9-endpoint")
DATABRICKS_HOST = _normalize_databricks_host(
    os.environ.get("DATABRICKS_HOST", "https://adb-770004969272846.6.azuredatabricks.net")
)


# ── System prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a Supervisor Agent orchestrating a Databricks multi-agent system.

For every user query, respond ONLY with a single valid JSON object — no markdown, no extra text:

{
  "answer": "<your complete, helpful response to the user>",
  "follow_ups": [
    "Suggested follow-up question 1",
    "Suggested follow-up question 2",
    "Suggested follow-up question 3"
  ],
  "routing": {
    "selected_agent": "<exactly one of: Customer Churn Analytics, Order Cancellation Prediction, Product Recommendation Genie, Customer Case Management, Customer Intelligence Agent>",
    "reasoning": "<one sentence explaining why this agent was chosen>",
    "confidence": <0.0-1.0>,
    "alternatives": ["<other agent names considered, if any>"]
  }
}

ROUTING RULES — follow strictly:
- Customer related queries (churn, retention, customer health, segments, loyalty, at-risk customers) → Customer Churn Analytics
- Orders related queries (order status, cancellations, order trends, order risk, order data) → Order Cancellation Prediction
- Similarity, recommendations, cross-sell, upsell, product suggestions → Product Recommendation Genie
- Cases, support tickets, issue tracking, case resolution, customer complaints → Customer Case Management
- Everything else: work orders, assets, contracts, entitlements, quotes, service history, field service, SLA → Customer Intelligence Agent

Rules for follow_ups:
- Always return 3 to 5 relevant, natural follow-up questions.
- Make them specific and actionable based on the current query and agent output.

Agent capabilities:
- Customer Churn Analytics: customer churn patterns, retention metrics, churn prediction, cohort analysis, at-risk customers
- Order Cancellation Prediction: order cancellation risk, order trends, order data queries, cancellation prediction
- Product Recommendation Genie: personalised product recommendations, cross-sell/upsell, similarity-based suggestions
- Customer Case Management: support cases, issue tracking, case resolution workflows, ticket management
- Customer Intelligence Agent: work orders, assets, contracts, entitlements, quotes, service history, SLA, field service"""

# ── SSL (suppress cert warnings for internal Databricks calls) ────────────────
ssl._create_default_https_context = ssl._create_unverified_context
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
os.environ['CURL_CA_BUNDLE']     = ''
os.environ['REQUESTS_CA_BUNDLE'] = ''

# ── Databricks SDK client (auto-authenticates via service principal) ──────────
try:
    _workspace_client = WorkspaceClient(host=DATABRICKS_HOST)
    _auth_mode = "sdk_default"
    _host = _workspace_client.config.host.rstrip("/")
    logger.info(f"Databricks SDK client ready - host: {_host} | auth: {_auth_mode}")
except Exception as exc:
    logger.warning(f"Databricks SDK init failed: {exc}")
    _workspace_client = None
    _auth_mode = "unavailable"
    _host = DATABRICKS_HOST


# ── Agent routing prediction ──────────────────────────────────────────────────

AGENT_KEYWORDS = {
    "Customer Churn Analytics": ["churn", "retention", "at-risk", "at risk", "loyalty", "health score",
                                  "segment", "cohort", "lifetime value", "clv", "churn risk"],
    "Order Cancellation Prediction": ["order", "cancel", "cancellation", "shipment", "delivery",
                                       "order status", "order risk", "order trend"],
    "Product Recommendation Genie": ["recommend", "similar", "cross-sell", "upsell", "product suggestion",
                                      "what else", "alternative", "suggestion"],
    "Customer Case Management": ["case", "ticket", "support", "complaint", "issue", "resolution",
                                  "escalat", "priority", "sentiment"],
    "Customer Intelligence Agent": ["work order", "asset", "contract", "entitlement", "quote",
                                     "service history", "field service", "sla", "warranty"],
}


def _predict_agents(query: str) -> list:
    """Predict which agents will be invoked based on query keywords."""
    query_lower = query.lower()
    matched = []

    # Check for "overall", "summary", "everything", "360" → likely multi-agent
    broad_terms = ["overall", "summary", "everything", "360", "full picture", "complete", "all about"]
    is_broad = any(t in query_lower for t in broad_terms)

    for agent, keywords in AGENT_KEYWORDS.items():
        if any(kw in query_lower for kw in keywords):
            matched.append(agent)

    if is_broad or not matched:
        # Broad queries hit all agents (or default to Intelligence Agent)
        if is_broad:
            matched = list(AGENT_KEYWORDS.keys())
        else:
            matched = ["Customer Intelligence Agent"]

    return matched


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_supervisor_tag(text: str) -> bool:
    return (text.startswith("<name>") and text.endswith("</name>")
            and ("Supervisor" in text or "Test_Supervisor" in text))


def _is_agent_tag(text: str) -> bool:
    return text.startswith("<name>") and text.endswith("</name>")


def _try_parse_supervisor_json(text: str):
    """Extract JSON from supervisor output — handles ```json fences too."""
    cleaned = text.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return None


def _coerce_json(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
    return value


def _extract_trace_id(result: dict):
    metadata = result.get("metadata") if isinstance(result, dict) else None
    databricks_output = result.get("databricks_output") if isinstance(result, dict) else None
    trace_payload = (
        databricks_output.get("trace")
        if isinstance(databricks_output, dict) and isinstance(databricks_output.get("trace"), dict)
        else None
    )
    trace_info = trace_payload.get("info") if isinstance(trace_payload, dict) else None
    if isinstance(metadata, dict) and metadata.get("trace_id"):
        return metadata.get("trace_id")
    if isinstance(trace_info, dict):
        for key in ("trace_id", "request_id", "mlflow_trace_id"):
            if isinstance(trace_info.get(key), str):
                return trace_info.get(key)
    spans = _trace_spans_from_payload(trace_payload) if trace_payload else []
    for span in spans:
        if isinstance(span, dict) and isinstance(span.get("trace_id"), str):
            return span.get("trace_id")
    for key in ("trace_id", "request_id", "mlflow_trace_id"):
        if isinstance(result.get(key), str):
            return result.get(key)
    return None


def _find_trace_payload(result: dict):
    """Find a returned MLflow trace payload from several response shapes."""
    metadata = result.get("metadata") if isinstance(result, dict) else {}
    custom_outputs = result.get("custom_outputs") if isinstance(result, dict) else {}
    databricks_output = result.get("databricks_output") if isinstance(result, dict) else {}
    candidates = [
        result.get("trace"),
        result.get("mlflow_trace"),
        result.get("databricks_trace"),
        metadata.get("trace") if isinstance(metadata, dict) else None,
        custom_outputs.get("trace") if isinstance(custom_outputs, dict) else None,
        databricks_output.get("trace") if isinstance(databricks_output, dict) else None,
    ]
    for candidate in candidates:
        candidate = _coerce_json(candidate)
        if isinstance(candidate, dict) and (
            "spans" in candidate or "data" in candidate or "trace" in candidate
        ):
            return candidate
    for value in result.values():
        value = _coerce_json(value)
        if not isinstance(value, dict):
            continue
        if "spans" in value or "data" in value:
            return value
        nested = _find_trace_payload(value)
        if nested:
            return nested
    return None


def _extract_final_response(result: dict):
    """Check custom_outputs.final_response and top-level final_response for the answer."""
    custom = result.get("custom_outputs") or {}
    final_text = custom.get("final_response") or result.get("final_response")
    if not final_text and isinstance(result.get("output_text"), str):
        final_text = result.get("output_text")
    if not final_text:
        trace_payload = _find_trace_payload(result)
        trace_info = trace_payload.get("info") if isinstance(trace_payload, dict) else {}
        trace_metadata = trace_info.get("trace_metadata") if isinstance(trace_info, dict) else {}
        trace_outputs = _coerce_json(trace_metadata.get("mlflow.traceOutputs")) if isinstance(trace_metadata, dict) else None
        if isinstance(trace_outputs, dict):
            final_text = trace_outputs.get("final_response") or trace_outputs.get("answer")
    if not final_text:
        return None

    parsed = _try_parse_supervisor_json(final_text)
    if parsed and isinstance(parsed, dict) and "answer" in parsed:
        return parsed

    if isinstance(final_text, str) and len(final_text.strip()) > 10:
        return {"answer": final_text.strip(), "follow_ups": [], "routing": None}

    return None


def _as_float(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _duration_ms_from(value):
    """Best-effort duration extraction from Databricks trace-like response items."""
    if not isinstance(value, dict):
        return None

    millisecond_keys = (
        "duration_ms", "elapsed_ms", "latency_ms", "execution_time_ms",
        "time_ms", "total_time_ms", "runtime_ms",
    )
    second_keys = (
        "duration", "elapsed", "latency", "execution_time",
        "time", "total_time", "runtime",
    )

    for key in millisecond_keys:
        found = _as_float(value.get(key))
        if found is not None:
            return max(0, found)

    for key in second_keys:
        found = _as_float(value.get(key))
        if found is not None:
            return max(0, found * 1000 if found < 1000 else found)

    for nested_key in ("metadata", "response_metadata", "custom_outputs", "usage", "metrics"):
        found = _duration_ms_from(value.get(nested_key))
        if found is not None:
            return found

    return None


def _friendly_timeline_label(agent_name: str, context: str = "") -> str:
    raw = (agent_name or "unknown").strip()
    raw_normalized = raw.lower()
    normalized = f"{raw} {context}".lower()

    internal_labels = {
        "fetching_metadata": "Fetching metadata",
        "filtering_context": "Filtering context",
        "asking_ai": "Reasoning",
        "pending_warehouse": "Waiting for warehouse",
        "executing_query": "Executed query",
    }
    if raw_normalized in internal_labels:
        return internal_labels[raw_normalized]
    if "example" in raw_normalized:
        return "Loading examples"
    if "llm" in normalized:
        return "Reasoning"
    if "churn" in normalized:
        return "Querying Customer Churn Analytics"
    if "cancellation" in normalized or "cancel" in normalized:
        return "Querying Order Cancellation Prediction"
    if "recommend" in normalized or "cross-sell" in normalized or "upsell" in normalized or "product" in normalized:
        return "Querying Product Recommendation Genie"
    if "case" in normalized:
        return "Querying Customer Case Management"
    if (
        "intelligence" in normalized or
        "contract" in normalized or
        "entitlement" in normalized or
        "work order" in normalized or
        "asset" in normalized or
        "quote" in normalized or
        "service history" in normalized or
        "field service" in normalized or
        "summary" in normalized or
        "customer" in normalized
    ):
        return "Querying Customer Intelligence Agent"
    if raw_normalized.startswith("genie-"):
        return "Executed query"
    if "supervisor" in normalized:
        return "Composing answer"

    return f"Querying {raw}"


def _timeline_weight(agent_name: str, label: str) -> float:
    normalized = f"{agent_name or ''} {label or ''}".lower()
    if "example" in normalized:
        return 1
    if "llm" in normalized or "reasoning" in normalized or "composing" in normalized:
        return 3
    if "genie" in normalized or "agent-" in normalized or "querying" in normalized:
        return 12
    return 6


def _timeline_entry(agent_name: str, source: dict) -> dict:
    context = str(source.get("arguments", "")) if isinstance(source, dict) else ""
    label = _friendly_timeline_label(agent_name, context)
    entry = {
        "type": "call",
        "agent": agent_name,
        "label": label,
        "weight": _timeline_weight(agent_name, label),
    }
    duration_ms = _duration_ms_from(source)
    if duration_ms is not None:
        entry["duration_ms"] = duration_ms
    return entry


def _finalize_timeline(timeline: list) -> list:
    """Mark the last LLM-like event as final composition while preserving call order."""
    for index in range(len(timeline) - 1, -1, -1):
        agent_name = str(timeline[index].get("agent", "")).lower()
        if "llm" in agent_name or timeline[index].get("label") == "Reasoning over results":
            timeline[index] = {
                **timeline[index],
                "label": "Composing answer",
                "weight": max(float(timeline[index].get("weight", 3)), 4),
            }
            break
    return timeline


def _trace_spans_from_payload(trace_payload):
    trace_payload = _coerce_json(trace_payload)
    if not isinstance(trace_payload, dict):
        return []

    data = trace_payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("spans"), list):
        return data.get("spans")
    if isinstance(trace_payload.get("spans"), list):
        return trace_payload.get("spans")

    nested_trace = trace_payload.get("trace")
    if nested_trace is not trace_payload:
        return _trace_spans_from_payload(nested_trace)

    return []


def _span_context(span: dict) -> str:
    attributes = span.get("attributes") if isinstance(span.get("attributes"), dict) else {}
    parts = [
        span.get("name"),
        span.get("span_type"),
        span.get("type"),
        span.get("inputs"),
        span.get("outputs"),
        attributes,
    ]
    return " ".join(str(part) for part in parts if part)


def _span_attributes(span: dict) -> dict:
    return span.get("attributes") if isinstance(span.get("attributes"), dict) else {}


def _clean_span_type(span: dict) -> str:
    attributes = _span_attributes(span)
    raw = attributes.get("mlflow.spanType") or span.get("span_type") or span.get("type") or ""
    raw = _coerce_json(raw)
    return str(raw).strip('"').upper()


def _compact_text(value, limit=150):
    if value is None:
        return ""
    text = str(value).replace("\n", " ").strip()
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return f"{text[:limit - 1].rstrip()}..."


def _first_text_from_value(value):
    value = _coerce_json(value)
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("genie_query", "query", "question", "request", "content", "answer", "final_response"):
            if isinstance(value.get(key), str) and value.get(key).strip():
                return value.get(key)
        messages = value.get("messages")
        if isinstance(messages, list):
            for message in reversed(messages):
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    return message.get("content")
        for nested in value.values():
            found = _first_text_from_value(nested)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _first_text_from_value(item)
            if found:
                return found
    return ""


def _span_summary(span: dict, kind: str, label: str) -> str:
    attributes = _span_attributes(span)
    inputs = attributes.get("mlflow.spanInputs") or span.get("inputs")
    outputs = attributes.get("mlflow.spanOutputs") or span.get("outputs")

    if kind in {"tool", "query"}:
        input_text = _first_text_from_value(inputs)
        if input_text:
            return _compact_text(input_text, 140)
        return "Executed query"

    if kind == "retrieval":
        return "Found similar requests for context."

    if kind == "reasoning":
        return ""

    output_text = _first_text_from_value(outputs)
    if output_text and output_text != label:
        return _compact_text(output_text, 140)

    return ""


def _span_kind(name: str, span_type: str) -> str:
    normalized = name.lower()
    if "example" in normalized or span_type == "RETRIEVER":
        return "retrieval"
    if normalized in {"asking_ai"} or "llm" in normalized or span_type in {"LLM", "CHAT_MODEL"}:
        return "reasoning"
    if normalized.startswith("genie-") or normalized in {"executing_query"} or "query" in normalized or "sql" in normalized:
        return "query"
    if "agent-" in normalized or span_type in {"TOOL", "UC_FUNCTION"}:
        return "tool"
    return "system"


def _span_duration_ms(span: dict):
    start_ns = _as_float(span.get("start_time_ns") or span.get("start_time_unix_nano"))
    end_ns = _as_float(span.get("end_time_ns") or span.get("end_time_unix_nano"))
    if start_ns is not None and end_ns is not None and end_ns >= start_ns:
        return (end_ns - start_ns) / 1_000_000

    start_ms = _as_float(span.get("start_time_ms") or span.get("start_ms"))
    end_ms = _as_float(span.get("end_time_ms") or span.get("end_ms"))
    if start_ms is not None and end_ms is not None and end_ms >= start_ms:
        return end_ms - start_ms

    return _duration_ms_from(span)


def _span_sort_value(span: dict):
    start_ns = _as_float(span.get("start_time_ns") or span.get("start_time_unix_nano"))
    if start_ns is not None:
        return start_ns
    start_ms = _as_float(span.get("start_time_ms") or span.get("start_ms"))
    if start_ms is not None:
        return start_ms * 1_000_000
    return 0


def _span_start_ns(span: dict):
    start_ns = _as_float(span.get("start_time_ns") or span.get("start_time_unix_nano"))
    if start_ns is not None:
        return start_ns
    start_ms = _as_float(span.get("start_time_ms") or span.get("start_ms"))
    if start_ms is not None:
        return start_ms * 1_000_000
    return None


def _is_relevant_trace_span(span: dict) -> bool:
    name = str(span.get("name") or "").lower()
    if not span.get("parent_span_id") and (name in {"predict", "agent", "run"} or name.startswith("predict")):
        return False
    duration_ms = _span_duration_ms(span)
    if duration_ms is not None and duration_ms < 250:
        return False
    context = _span_context(span).lower()
    if any(term in context for term in (
        "examples", "llm", "genie", "agent-", "tool",
        "serving_endpoint", "chat_model", "chat model", "uc_function",
    )):
        return True
    span_type = _clean_span_type(span)
    return span_type in {"LLM", "CHAT_MODEL", "TOOL", "RETRIEVER", "CHAIN", "AGENT"}


def _span_depths(spans: list) -> dict:
    by_id = {
        span.get("span_id"): span
        for span in spans
        if isinstance(span, dict) and span.get("span_id")
    }
    cache = {}

    def depth_for(span: dict):
        span_id = span.get("span_id")
        if span_id in cache:
            return cache[span_id]
        parent_id = span.get("parent_span_id")
        parent = by_id.get(parent_id)
        if not parent:
            cache[span_id] = 0
            return 0
        cache[span_id] = depth_for(parent) + 1
        return cache[span_id]

    for span in by_id.values():
        depth_for(span)
    return cache


def _timeline_from_trace_payload(trace_payload) -> list:
    all_spans = _trace_spans_from_payload(trace_payload)
    depths = _span_depths(all_spans)
    spans = [
        span for span in _trace_spans_from_payload(trace_payload)
        if isinstance(span, dict) and _is_relevant_trace_span(span)
    ]
    spans.sort(key=_span_sort_value)
    trace_start_ns = min(
        (start_ns for start_ns in (_span_start_ns(span) for span in spans) if start_ns is not None),
        default=None,
    )

    timeline = []
    for span in spans:
        name = str(span.get("name") or span.get("span_type") or span.get("type") or "span")
        span_type = _clean_span_type(span)
        context = _span_context(span)
        label = _friendly_timeline_label(name, context)
        kind = _span_kind(name, span_type)
        entry = {
            "type": "call",
            "agent": name,
            "label": label,
            "weight": _timeline_weight(name, label),
            "kind": kind,
            "depth": max(0, depths.get(span.get("span_id"), 0) - 1),
            "summary": _span_summary(span, kind, label),
            "span_id": span.get("span_id"),
            "parent_span_id": span.get("parent_span_id"),
        }
        duration_ms = _span_duration_ms(span)
        if duration_ms is not None:
            entry["duration_ms"] = duration_ms
        start_ns = _span_start_ns(span)
        if trace_start_ns is not None and start_ns is not None:
            entry["start_offset_ms"] = max(0, (start_ns - trace_start_ns) / 1_000_000)
        timeline.append(entry)

    return _finalize_timeline(timeline)


def _parse_agent_response(result: dict) -> dict:
    trace_id = _extract_trace_id(result)
    returned_timeline = _timeline_from_trace_payload(_find_trace_payload(result))

    # ── Priority 1: Check custom_outputs.final_response ──────────────────────
    final_from_custom = _extract_final_response(result)
    if final_from_custom:
        logger.debug("Answer extracted from custom_outputs.final_response")
        return {
            "answer":            final_from_custom.get("answer", ""),
            "routing":           final_from_custom.get("routing"),
            "trace":             [],
            "timeline":          returned_timeline,
            "trace_id":          trace_id,
            "sub_agent_content": [],
            "images":            [],
            "follow_ups":        final_from_custom.get("follow_ups", [])[:5],
        }

    # ── Priority 2: Parse the output list ────────────────────────────────────
    output = result.get("output", [])
    if isinstance(output, str):
        return {
            "answer": output, "routing": None,
            "trace": [], "timeline": returned_timeline, "trace_id": trace_id,
            "sub_agent_content": [], "images": [], "follow_ups": []
        }

    trace                 = []
    timeline              = []
    sub_agent_items       = []
    images                = []
    active_agent          = None
    supervisor_next       = False
    supervisor_candidates = []
    last_substantial_text = ""

    for item in output:
        itype = item.get("type")

        if itype == "function_call":
            active_agent    = item.get("name", "unknown")
            supervisor_next = False
            try:
                args = json.loads(item.get("arguments", "{}"))
            except Exception:
                args = {"raw": item.get("arguments", "")}
            trace_entry = {"type": "call", "agent": active_agent, "query": args}
            duration_ms = _duration_ms_from(item)
            if duration_ms is not None:
                trace_entry["duration_ms"] = duration_ms
            trace.append(trace_entry)
            timeline.append(_timeline_entry(active_agent, item))

        elif itype == "message":
            for block in item.get("content", []):
                if block.get("type") != "output_text":
                    continue
                text = block.get("text", "").strip()
                if not text or text.upper() == "EMPTY":
                    continue

                if _is_agent_tag(text):
                    supervisor_next = _is_supervisor_tag(text)
                    continue

                parsed_json = _try_parse_supervisor_json(text)
                if parsed_json and isinstance(parsed_json, dict):
                    supervisor_candidates.append(parsed_json)
                    trace.append({"type": "supervisor_final", "agent": "Supervisor", "content": "Answer compiled"})
                    continue

                sub_agent_items.append({"agent": active_agent or "unknown", "content": text})
                if len(text) > len(last_substantial_text):
                    last_substantial_text = text

                for word in text.split():
                    if word.startswith("http") and any(
                        word.lower().endswith(e) for e in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
                    ):
                        images.append(word)

                trace.append({"type": "response", "agent": active_agent or "Sub-Agent", "content": text})

    # ── Extract final answer ─────────────────────────────────────────────────
    if supervisor_candidates:
        final            = supervisor_candidates[-1]
        final_answer     = final.get("answer", "No response received")
        final_routing    = final.get("routing")
        final_follow_ups = final.get("follow_ups", [])
    elif last_substantial_text:
        logger.info("No supervisor JSON found — using last substantial sub-agent response as answer")
        final_answer     = last_substantial_text
        final_routing    = None
        final_follow_ups = []
    else:
        final_answer     = "No response received."
        final_routing    = None
        final_follow_ups = []

    if not isinstance(final_follow_ups, list):
        final_follow_ups = []

    return {
        "answer":            final_answer,
        "routing":           final_routing,
        "trace":             trace,
        "timeline":          returned_timeline or _finalize_timeline(timeline),
        "trace_id":          trace_id,
        "sub_agent_content": sub_agent_items,
        "images":            images,
        "follow_ups":        final_follow_ups[:5],
    }


def _call_agent_endpoint(messages: list) -> dict:
    """POST to the Databricks serving endpoint using service principal auth."""
    if not _workspace_client:
        raise RuntimeError(
            "Databricks SDK client is not initialized. Check DATABRICKS_HOST."
        )
    auth_headers = _workspace_client.config.authenticate()

    responses_url = f"{_host}/serving-endpoints/responses"
    legacy_url = f"{_host}/serving-endpoints/{SERVING_ENDPOINT}/invocations"
    logger.info(f"Calling endpoint: {responses_url}")

    try:
        resp = requests.post(
            responses_url,
            headers={
                **auth_headers,
                "Content-Type": "application/json",
                "x-mlflow-return-trace-id": "true",
            },
            json={
                "model": SERVING_ENDPOINT,
                "input": messages,
                "databricks_options": {"return_trace": True},
            },
            timeout=(10, 600),
            verify=False,
        )
        if resp.status_code in {400, 404, 405}:
            logger.warning(
                f"Responses API returned {resp.status_code}; falling back to legacy invocations endpoint"
            )
            resp = requests.post(
                legacy_url,
                headers={
                    **auth_headers,
                    "Content-Type": "application/json",
                },
                json={"input": messages},
                timeout=(10, 600),
                verify=False,
            )
    except requests.exceptions.ReadTimeout:
        logger.error("Serving endpoint read timed out after 600s")
        raise ValueError(
            "The agent took too long to respond (>10 minutes). Please try a simpler or more specific query."
        )
    except requests.exceptions.ConnectionError as exc:
        logger.error(f"Connection error to serving endpoint: {exc}")
        raise ValueError(
            "Could not connect to the agent endpoint. It may be starting up — please try again in a moment."
        )

    content_type = resp.headers.get("Content-Type", "")
    if "text/html" in content_type or resp.text.strip().startswith("<!DOCTYPE") or resp.text.strip().startswith("<html"):
        logger.error(f"Endpoint returned HTML (status {resp.status_code}). Likely gateway timeout or auth issue.")
        raise ValueError(
            "The agent is taking too long to respond. Please try a simpler query or try again."
        )

    if not resp.ok:
        logger.error(f"Endpoint returned {resp.status_code}: {resp.text[:300]}")
        resp.raise_for_status()

    try:
        return resp.json()
    except json.JSONDecodeError as exc:
        logger.error(f"Non-JSON response: {resp.text[:200]}")
        raise ValueError(f"Endpoint returned invalid JSON: {resp.text[:100]}") from exc


# ── Global error handlers — always return JSON, never HTML ────────────────────

def _stream_agent_endpoint(messages: list):
    """Stream Databricks Responses API events and translate real progress into app SSE events."""
    if not _workspace_client:
        raise RuntimeError(
            "Databricks SDK client is not initialized. Check DATABRICKS_HOST."
        )
    auth_headers = _workspace_client.config.authenticate()

    responses_url = f"{_host}/serving-endpoints/responses"
    output_items = []
    completed_payload = None
    saw_tool_call = False
    current_step_key = None

    def app_event(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    def emit_step(label: str, key: str, kind: str = "reasoning"):
        nonlocal current_step_key
        if current_step_key == key:
            return None
        current_step_key = key
        return app_event({
            "type": "live_step",
            "label": label,
            "key": key,
            "kind": kind,
        })

    try:
        with requests.post(
            responses_url,
            headers={
                **auth_headers,
                "Content-Type": "application/json",
                "x-mlflow-return-trace-id": "true",
            },
            json={
                "model": SERVING_ENDPOINT,
                "input": messages,
                "stream": True,
                "databricks_options": {"return_trace": True},
            },
            timeout=(10, 600),
            verify=False,
            stream=True,
        ) as resp:
            if resp.status_code in {400, 404, 405}:
                logger.warning(
                    f"Streaming Responses API returned {resp.status_code}; using synchronous fallback"
                )
                parsed = _parse_agent_response(_call_agent_endpoint(messages))
                yield app_event({"type": "done", "data": parsed})
                return

            if not resp.ok:
                logger.error(f"Streaming endpoint returned {resp.status_code}: {resp.text[:300]}")
                resp.raise_for_status()

            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data: "):
                    continue
                raw_event = line[6:]
                if raw_event == "[DONE]":
                    break
                try:
                    event = json.loads(raw_event)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type")
                if event_type == "response.output_text.delta":
                    label = "Composing answer" if saw_tool_call else "Reasoning"
                    key = "compose" if saw_tool_call else "reasoning"
                    step_event = emit_step(label, key, "reasoning")
                    if step_event:
                        yield step_event
                    continue

                if event_type == "response.output_item.done":
                    item = event.get("item") if isinstance(event.get("item"), dict) else {}
                    if item:
                        output_items.append(item)

                    if item.get("type") == "function_call":
                        saw_tool_call = True
                        name = item.get("name") or "tool"
                        context = str(item.get("arguments") or "")
                        label = _friendly_timeline_label(name, context)
                        kind = _span_kind(name, "TOOL")
                        step_key = item.get("call_id") or f"{name}-{event.get('step')}"
                        step_event = emit_step(label, f"tool-{step_key}", kind)
                        if step_event:
                            yield step_event
                    elif item.get("type") == "message":
                        content = item.get("content") if isinstance(item.get("content"), list) else []
                        text = " ".join(
                            block.get("text", "")
                            for block in content
                            if isinstance(block, dict) and block.get("type") == "output_text"
                        ).strip()
                        if item.get("call_id"):
                            step_event = emit_step("Reasoning", f"reasoning-after-{item.get('call_id')}", "reasoning")
                            if step_event:
                                yield step_event
                        elif text and not _is_agent_tag(text) and not saw_tool_call:
                            step_event = emit_step("Reasoning", f"reasoning-{event.get('step', 'initial')}", "reasoning")
                            if step_event:
                                yield step_event
                    continue

                if event_type == "response.completed":
                    completed_payload = {
                        **(event.get("response") if isinstance(event.get("response"), dict) else {}),
                        "databricks_output": event.get("databricks_output"),
                        "custom_outputs": event.get("custom_outputs"),
                        "output": output_items,
                    }
                    break

        if completed_payload is None:
            completed_payload = {"output": output_items}

        parsed = _parse_agent_response(completed_payload)
        yield app_event({"type": "done", "data": parsed})

    except requests.exceptions.ReadTimeout:
        logger.error("Streaming serving endpoint read timed out after 600s")
        raise ValueError(
            "The agent took too long to respond (>10 minutes). Please try a simpler or more specific query."
        )
    except requests.exceptions.ConnectionError as exc:
        logger.error(f"Connection error to streaming serving endpoint: {exc}")
        raise ValueError(
            "Could not connect to the agent endpoint. It may be starting up — please try again in a moment."
        )


@app.errorhandler(400)
def bad_request(e):
    return jsonify({"error": "Bad request", "detail": str(e)}), 400

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({"error": "Method not allowed"}), 405

@app.errorhandler(500)
def internal_error(e):
    logger.error(f"Unhandled 500: {e}", exc_info=True)
    return jsonify({"error": "Internal server error", "detail": str(e)}), 500

@app.errorhandler(Exception)
def unhandled_exception(e):
    logger.error(f"Unhandled exception: {e}", exc_info=True)
    return jsonify({"error": "Unexpected server error", "detail": str(e)}), 500

# ─────────────────────────────────────────────────────────────────────────────


@app.before_request
def log_req():
    logger.debug(f"{request.method} {request.url}")


@app.after_request
def set_response_headers(response):
    """Ensure all API responses have correct content-type to prevent proxy confusion."""
    if request.path.startswith("/api/") and "text/event-stream" not in (response.headers.get("Content-Type") or ""):
        response.headers["Content-Type"] = "application/json"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/chat", methods=["POST"])
def chat():
    """Streaming SSE endpoint — sends agent progress events then the final answer."""
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid or missing JSON body"}), 400

        messages = data.get("messages", [])
        if not messages:
            return jsonify({"error": "No messages provided"}), 400

        user_query = messages[-1].get("content", "") if messages else ""
        predicted_agents = _predict_agents(user_query)
        full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    def generate():
        try:
            yield f"data: {json.dumps({'type': 'status', 'message': 'Analyzing your query...'})}\n\n"
            yield f"data: {json.dumps({'type': 'routing', 'agents': predicted_agents})}\n\n"
            yield from _stream_agent_endpoint(full_messages)
            return
        except Exception as exc:
            logger.error(f"Streaming chat failed: {exc}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status":   "healthy" if _workspace_client else "degraded",
        "endpoint": SERVING_ENDPOINT,
        "host":     _host,
        "auth":     _auth_mode,
    })


@app.route("/<path:path>")
def spa_fallback(path):
    """Serve built assets directly and route everything else to the React app."""
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404

    asset_path = os.path.join(app.static_folder, path)
    if os.path.exists(asset_path) and os.path.isfile(asset_path):
        return send_from_directory(app.static_folder, path)

    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    logger.info("=== STARTUP DIAGNOSTICS ===")
    logger.info(f"CWD: {os.getcwd()}")
    static_path = os.path.join(os.getcwd(), "dist")
    if os.path.exists(static_path):
        logger.info(f"static/ contents: {os.listdir(static_path)}")
    else:
        logger.error("CRITICAL: static/ directory DOES NOT EXIST")
    logger.info(f"Host: {_host} | Endpoint: {SERVING_ENDPOINT}")
    if _workspace_client:
        logger.info(f"SDK auth OK - using {_auth_mode}")
    else:
        logger.error("No Databricks auth initialized - /api/chat will fail")
    logger.info("===========================")
    port = int(os.environ.get("PORT", os.environ.get("DATABRICKS_APP_PORT", 8000)))
    app.run(host="0.0.0.0", port=port, debug=False)
