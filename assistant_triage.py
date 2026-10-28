"""Safety triage, sanitization, rate limiting and answers for the R.M Digital Centre assistant."""

from __future__ import annotations

import os
import re
import threading
import time
import unicodedata
from collections import deque
from typing import Callable

MAX_MESSAGE_CHARS = 500

ILLEGAL_PATTERNS = [
    r"(?i)\b(hack(?:ing|ed|er|ers)?|bypass(?:ing)?|exploit(?:ing|s)?|counterfeit|malware|steal(?:ing)?)\b",
    r"(?i)\b(data|database|customer|kyc|aadhaar)\s*(leak|leaks|dump|breach)\b",
    r"(?i)\b(leak|dump)\s*(the\s*)?(data|database|customer|kyc|aadhaar|records)\b",
    r"(?i)\bfake\s*(doc|docs|document|documents|aadhaar|pan)\b",
    r"(?i)\b(crack(?:ing|ed)?)\s*(password|login|otp|account|software)\b",
    r"(?i)\b(sql\s*injection|injection\s*attack|xss)\b",
    r"(?i)\b(unauthori[sz]ed)\s*(access|transaction|login)\b",
    r"(?i)\b(evade|avoid|skip)\s*kyc\b",
    r"(?i)\btamper(?:ing|ed)?\b",
]

# Identity questions and prompt-injection attempts get the same guarded reply.
IDENTITY_PATTERNS = [
    r"(?i)who\s*(made|created|developed|built|owns|engineered|trained)\s*(you|this)",
    r"(?i)(kaun|kisne|kisne\s*ye)\s*banaya",
    r"(?i)kiska\s*(system|bot|assistant|hai)",
    r"(?i)\b(owner|founder|creator|developer|programmer|engineer)s?\b.{0,20}\b(name|details|info|kaun|who)\b",
    r"(?i)\b(name|details|who).{0,20}\b(owner|founder|creator|developer|programmer)\b",
    r"(?i)\b(openai|chat\s*gpt|gpt-?\d*|google\s*ai|gemini|bard|llama|claude|anthropic|copilot|mistral|deepseek)\b",
    r"(?i)\b(which|what)\s*(llm|model|ai|language\s*model)\b",
    r"(?i)ignore\s*(all\s*|any\s*)?(the\s*)?(previous|prior|above|earlier)\s*(instructions|rules|prompts?)",
    r"(?i)(system\s*prompt|developer\s*mode|reveal\s*(your\s*)?(prompt|instructions)|jailbreak|act\s*as\s*dan)",
    r"(?i)(forget|disregard)\s*(your|all|the)\s*(rules|instructions|guidelines)",
]

ILLEGAL_REPLY = (
    "Legal Notice: This request relates to hacking, data leakage, fraud or bypassing policy, "
    "which is prohibited under applicable law and R.M Digital Centre policy. Such activity is "
    "monitored and may be reported to the authorities. Please ask only about authorized portal services."
)

IDENTITY_REPLY = (
    "I am an automated proprietary assistant engineered and governed exclusively by R.M Digital Centre."
)

RATE_LIMIT_REPLY = "Too many messages. Please wait a minute before asking again."
EMPTY_REPLY = "Please type your question about R.M Digital Centre services."

LEGAL_FALLBACK_TEXT = (
    "I am an automated assistant of R.M Digital Centre. Internal development records, "
    "creator identities and systems are private and protected. "
    "Please ask about portal services or transactions."
)

BANNED_LIVE_PATTERNS = [
    r"(?i)(openai|chatgpt|google\s*ai|gemini|llama|claude|anthropic)",
    r"(?i)(secret_key|password|bearer|auth_token|database_url)",
    r"(?i)(vulnerability|exploit|bypass|leak)",
]

# Private names to hide, comma-separated, supplied via environment (never hardcoded).
_extra_names = [n.strip() for n in os.environ.get("ASSISTANT_BANNED_NAMES", "").split(",") if n.strip()]
if _extra_names:
    BANNED_LIVE_PATTERNS.append(r"(?i)(" + "|".join(re.escape(n) for n in _extra_names) + ")")

_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff\u00ad"))


def sanitize_message(message: object) -> str:
    """Normalize and bound user input so pattern checks cannot be evaded by tricks."""
    if not isinstance(message, str):
        return ""
    text = unicodedata.normalize("NFKC", message).translate(_ZERO_WIDTH)
    text = "".join(ch if ch in "\n\t" or unicodedata.category(ch)[0] != "C" else " " for ch in text)
    text = re.sub(r"[<>`{}\\]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_MESSAGE_CHARS]


class RateLimiter:
    """Thread-safe sliding-window limiter keyed by user."""

    def __init__(self, limit: int = 15, window_seconds: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            if len(self._hits) > 5000:
                for stale in [k for k, v in self._hits.items() if not v or now - v[-1] >= self.window]:
                    del self._hits[stale]
            return True


def live_stream_filter(ai_response_text: str) -> str:
    """Replace a response sentence with the fallback text if it matches any banned pattern."""
    for pattern in BANNED_LIVE_PATTERNS:
        if re.search(pattern, ai_response_text):
            return LEGAL_FALLBACK_TEXT
    return ai_response_text


def triage_and_reply(user_query: str) -> dict[str, str] | None:
    """Return a canned reply for illegal/identity queries, else None."""
    for pattern in ILLEGAL_PATTERNS:
        if re.search(pattern, user_query):
            return {"reply": ILLEGAL_REPLY}
    for pattern in IDENTITY_PATTERNS:
        if re.search(pattern, user_query):
            return {"reply": IDENTITY_REPLY}
    return None


def triage_ai_query(user_query: object, session_user: object):
    """Auth + triage only. Returns ({"error"...}, 401), {"reply": ...} if intercepted, or None if safe."""
    if not session_user:
        return {"error": "Unauthorized. Please login to access support."}, 401
    return triage_and_reply(sanitize_message(user_query))


# Local, deterministic answers; no external AI provider is contacted.
KNOWLEDGE_BASE: list[tuple[tuple[str, ...], str]] = [
    (("hello", "hi", "namaste", "hey"),
     "Namaste! I can help with wallet, AEPS, recharge, PAN, insurance and other portal services. What do you need?"),
    (("wallet", "balance", "add money", "statement"),
     "Use the Wallet bar at the top of your dashboard: Available Balance, Wallet Statement and Add Money."),
    (("commission", "slab", "earning", "payout"),
     "Commission slabs for each service are shown in the Commission Structure page and on each service card."),
    (("aeps", "withdraw", "deposit", "mini statement"),
     "AEPS services are under Favourite Box and BC Banking. Keep the customer's Aadhaar-linked bank and a biometric device ready."),
    (("pan",),
     "Open E-Governance > PAN Card to start a PAN application. Documents are processed securely and not shared."),
    (("recharge", "bill", "electricity", "fastag", "dth", "emi"),
     "Recharge & Bill Payment lists mobile, electricity, gas, Fastag, credit card, loan EMI, broadband and OTT services."),
    (("insurance",),
     "Insurance & Travel includes car and bike insurance. Open the card to view details and commission."),
    (("password", "otp", "pin"),
     "Never share your password, OTP or PIN with anyone, including support. Use Change Password in the sidebar to update it."),
    (("support", "helpline", "complaint", "ticket", "help"),
     "You can raise a support ticket from your Retailer profile page, or contact the official helpline shown there."),
]

DEFAULT_REPLY = (
    "I can help with R.M Digital Centre services such as wallet, AEPS, recharge, PAN and insurance. "
    "Please rephrase your question, or raise a support ticket from your profile page."
)


def local_answer(message: str) -> str:
    words = set(re.findall(r"[a-z]+", message.lower()))
    lowered = message.lower()
    for keywords, answer in KNOWLEDGE_BASE:
        if any((k in words) if " " not in k else (k in lowered) for k in keywords):
            return answer
    return DEFAULT_REPLY


def handle_chat(
    raw_message: object,
    session_user: object,
    limiter: RateLimiter,
    rate_key: str,
    answer: Callable[[str], str] = local_answer,
) -> tuple[dict[str, str], int]:
    """Full pipeline: auth -> rate limit -> sanitize -> triage -> answer -> output filter."""
    if not session_user:
        return {"error": "Unauthorized. Please login to access support."}, 401
    if not limiter.allow(rate_key):
        return {"reply": RATE_LIMIT_REPLY}, 429
    message = sanitize_message(raw_message)
    if not message:
        return {"reply": EMPTY_REPLY}, 200
    blocked = triage_and_reply(message)
    if blocked:
        return blocked, 200
    reply = answer(message)
    # Local answers are trusted; scrub only output from an injected (e.g. LLM) answerer.
    return {"reply": reply if answer is local_answer else live_stream_filter(reply)}, 200
