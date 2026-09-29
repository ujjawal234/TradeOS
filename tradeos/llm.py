"""Thin wrapper around the Anthropic SDK (imported lazily so the rest works without it)."""
from __future__ import annotations

import json
import re


class LLMUnavailable(RuntimeError):
    pass


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("Model did not return JSON")
    return json.loads(m.group(0))


class LLM:
    def __init__(self, settings, client=None):
        self.model = settings.model
        if client is not None:
            self.client = client
            return
        if not settings.anthropic_api_key:
            raise LLMUnavailable("ANTHROPIC_API_KEY is not set (put it in .env).")
        try:
            import anthropic
        except ImportError as e:
            raise LLMUnavailable("pip install anthropic") from e
        self.client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    def create(self, system: str, messages: list, tools: list | None = None, max_tokens: int = 4096):
        kwargs = dict(model=self.model, max_tokens=max_tokens, messages=messages,
                      system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}])
        if tools:
            kwargs["tools"] = tools
        return self.client.messages.create(**kwargs)

    def complete_json(self, system: str, prompt: str, max_tokens: int = 6000) -> dict:
        resp = self.create(system, [{"role": "user", "content": prompt}], max_tokens=max_tokens)
        text = "".join(getattr(b, "text", "") for b in resp.content)
        return parse_json(text)
