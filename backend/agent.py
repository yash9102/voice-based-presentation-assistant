import json
import os
import re

from openai import AsyncAzureOpenAI

client = AsyncAzureOpenAI(
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT", ""),
    api_key=os.getenv("AZURE_OPENAI_API_KEY", ""),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21"),
)
DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")

SYSTEM_PROMPT = """You are Alex — a brilliant, charismatic AI presentation host.

You have memorized this entire presentation and you are an expert on its subject matter. You don't just read slides — you *understand* them. You can explain concepts, give real-world examples, draw analogies, compare ideas across slides, and answer any question about the content with depth and clarity.

━━━ FULL PRESENTATION DECK ━━━
{full_deck}

━━━ SESSION STATE ━━━
Currently on: Slide {current_slide_num} of {total_slides} — "{current_slide_title}"
Slides already presented: {presented_slides}

━━━ WHAT YOU CAN DO ━━━
• Answer any question about the content — going beyond the slide bullets with examples and your own knowledge
• Navigate to the most relevant slide when a topic is raised
• Compare and contrast content across slides ("On slide 2 we saw X, which connects to this because...")
• Recap what's been covered ("So far we've looked at...")
• Elaborate on any concept with real-world examples and analogies
• Re-explain in simpler terms if the audience seems confused
• Acknowledge when a question is interesting or insightful

━━━ RESPONSE FORMAT ━━━
Always reply with valid JSON — nothing else:
{{"navigate_to": <1-based slide number or null>, "response": "<what to say out loud>"}}

navigate_to: use the slide number if the user's question is best answered by a specific slide. Otherwise null.

━━━ HOW TO SPEAK ━━━
• Natural, flowing, conversational — think TED talk, not textbook
• Never read bullet points verbatim — synthesize and explain in your own words
• 2 sentences for a quick answer, 4–5 for a full explanation
• Use phrases like "Great question", "What's really interesting here is", "Think of it this way", "That actually connects to slide X where..."
• End slides with a forward bridge: "...and that leads us to our next idea" or "...which is exactly what we explore next"
• No markdown, no lists, no numbering in your spoken response — only full natural sentences"""


SENTENCE_PATTERN = re.compile(r"[^.!?]+[.!?]")

PRESENT_ALL_PHRASES = [
    "present all", "present the whole", "present everything", "go through all",
    "walk me through all", "full presentation", "show all slides",
    "go through the presentation", "entire presentation",
    "start the presentation", "begin the presentation", "all slides",
    "start from the beginning", "from the very beginning", "from scratch",
]

PRESENT_FROM_HERE_PHRASES = [
    "from here", "from this slide", "continue", "carry on", "keep going",
    "go on", "resume", "present the rest", "rest of the slides",
    "remaining slides", "walk me through", "walk through",
    "continue presenting", "continue the presentation",
    "from here onwards", "onwards", "proceed",
]


def detect_present_intent(text: str) -> str:
    t = text.lower().strip()
    # "present all" wins over "from here" if both match
    if any(p in t for p in PRESENT_ALL_PHRASES):
        return "all"
    if any(p in t for p in PRESENT_FROM_HERE_PHRASES):
        return "from_here"
    return "none"


def build_full_deck(slides: list[dict]) -> str:
    """Build a rich context string with everything on every slide."""
    parts = []
    for i, s in enumerate(slides):
        title = s.get("title", "")
        bullets = s.get("bullets", [])
        notes = s.get("speaker_notes", "")
        keywords = s.get("keywords", [])
        visual = s.get("visual_hint", "")

        block = f"[Slide {i + 1}] {title}"
        if bullets:
            block += "\nKey points:\n" + "\n".join(f"  • {b}" for b in bullets)
        if notes:
            block += f"\nPresenter notes: {notes}"
        if keywords:
            block += f"\nKeywords: {', '.join(keywords)}"
        if visual:
            block += f"\nVisual: {visual}"
        parts.append(block)
    return "\n\n".join(parts)


def split_sentences(text: str) -> list[str]:
    matches = SENTENCE_PATTERN.findall(text.strip())
    remainder = SENTENCE_PATTERN.sub("", text.strip()).strip()
    if remainder:
        matches.append(remainder)
    return [s.strip() for s in matches if s.strip()]


class CancellationToken:
    def __init__(self):
        self._cancelled = False

    def cancel(self):
        self._cancelled = True

    def reset(self):
        self._cancelled = False

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled


class AgentSession:
    def __init__(self):
        self.cancel_token = CancellationToken()
        self.slides: list[dict] = []
        self.current_slide: int = 0
        self.presented: set[int] = set()   # which slides the AI has narrated
        self.history: list[dict] = []
        self.req_id = None   # echoed back so the client can discard stale output

    def cancel(self):
        self.cancel_token.cancel()

    def _clamp(self, idx: int) -> int:
        if not self.slides:
            return 0
        return max(0, min(int(idx), len(self.slides) - 1))

    async def _send(self, ws, payload: dict):
        if self.req_id is not None:
            payload = {**payload, "req_id": self.req_id}
        await ws.send_json(payload)

    async def handle(self, ws, msg: dict):
        t = msg.get("type")

        if t == "interrupt":
            self.cancel_token.cancel()
            return

        self.req_id = msg.get("req_id")
        # A new request always supersedes whatever was interrupted before it.
        self.cancel_token.reset()

        if t == "start_presentation":
            self.slides = msg.get("slides", [])
            self.current_slide = self._clamp(msg.get("slide", 0))
            await self._narrate_slide(ws, self.current_slide)

        elif t == "navigate_request":
            idx = self._clamp(msg.get("slide", 0))
            self.current_slide = idx
            await self._narrate_slide(ws, idx)

        elif t == "user_input":
            self.current_slide = self._clamp(msg.get("current_slide", self.current_slide))
            user_text = msg.get("text", "").strip()
            intent = detect_present_intent(user_text)

            if intent == "all":
                await self._send_text(ws, "Absolutely! Let me take you through the whole presentation from the start.")
                await self._send(ws, {"type": "speech_end"})
                await self._send(ws, {"type": "start_auto_present", "from_slide": 0})

            elif intent == "from_here":
                n = self.current_slide + 1
                suffix = "the rest of the presentation" if self.current_slide > 0 else "the presentation"
                await self._send_text(ws, f"Sure, let me continue with {suffix} from slide {n}.")
                await self._send(ws, {"type": "speech_end"})
                await self._send(ws, {"type": "start_auto_present", "from_slide": self.current_slide})

            else:
                await self._agent_response(ws, user_text)

    async def _send_text(self, ws, text: str):
        sentences = split_sentences(text)
        for i, s in enumerate(sentences):
            if self.cancel_token.is_cancelled:
                return
            await self._send(ws, {"type": "text_chunk", "text": s, "is_final": i == len(sentences) - 1})

    async def _narrate_slide(self, ws, idx: int):
        self.cancel_token.reset()
        if not self.slides or idx >= len(self.slides):
            return
        self.presented.add(idx)
        slide = self.slides[idx]
        notes = slide.get("speaker_notes") or (
            slide.get("title", "") + ". " + ". ".join(slide.get("bullets", []))
        )
        sentences = split_sentences(notes)
        for i, sentence in enumerate(sentences):
            if self.cancel_token.is_cancelled:
                return
            await self._send(ws, {
                "type": "text_chunk",
                "text": sentence,
                "is_final": i == len(sentences) - 1,
            })
        await self._send(ws, {"type": "speech_end"})

    def _build_system(self) -> str:
        current = self.slides[self.current_slide] if self.slides else {}

        if self.presented:
            presented_str = ", ".join(
                f"Slide {i + 1} ({self.slides[i].get('title', '')})"
                for i in sorted(self.presented)
                if i < len(self.slides)
            )
        else:
            presented_str = "None yet"

        return SYSTEM_PROMPT.format(
            full_deck=build_full_deck(self.slides),
            current_slide_num=self.current_slide + 1,
            total_slides=len(self.slides),
            current_slide_title=current.get("title", ""),
            presented_slides=presented_str,
        )

    async def _agent_response(self, ws, user_text: str):
        self.cancel_token.reset()
        await self._send(ws, {"type": "thinking", "active": True})

        self.history.append({"role": "user", "content": user_text})
        if len(self.history) > 24:
            self.history = self.history[-24:]

        full_response = ""
        try:
            stream = await client.chat.completions.create(
                model=DEPLOYMENT,
                messages=[
                    {"role": "system", "content": self._build_system()},
                    *self.history,
                ],
                stream=True,
                response_format={"type": "json_object"},
                max_completion_tokens=450,
            )
            async for chunk in stream:
                if self.cancel_token.is_cancelled:
                    return
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full_response += delta
        except Exception as e:
            await self._send(ws, {"type": "error", "message": str(e)})
            return
        finally:
            await self._send(ws, {"type": "thinking", "active": False})

        if self.cancel_token.is_cancelled:
            return

        try:
            data = json.loads(full_response)
        except json.JSONDecodeError:
            await self._send(ws, {"type": "error", "message": "Could not parse AI response"})
            return

        navigate_to = data.get("navigate_to")
        if navigate_to is not None:
            target = self._clamp(int(navigate_to) - 1)
            self.current_slide = target
            self.presented.add(target)
            await self._send(ws, {"type": "navigate", "slide": target, "reason": "user question"})

        response_text = data.get("response", "")
        sentences = split_sentences(response_text)
        for i, sentence in enumerate(sentences):
            if self.cancel_token.is_cancelled:
                return
            await self._send(ws, {
                "type": "text_chunk",
                "text": sentence,
                "is_final": i == len(sentences) - 1,
            })

        self.history.append({"role": "assistant", "content": response_text})
        await self._send(ws, {"type": "speech_end"})




