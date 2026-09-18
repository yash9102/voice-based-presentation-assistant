# Voice Presentation AI

An AI-powered voice presentation tool. An AI agent narrates your slides, answers questions, navigates intelligently, and can be interrupted mid-sentence — all via natural speech.

## Features

- **AI slide generation** — type a topic, get a 6-slide presentation in seconds
- **Manual slide creation** — build your own slides with titles and bullet points
- **Voice narration** — Azure Neural TTS (JennyNeural) reads slides naturally
- **Interruptible** — speak at any time to stop the AI and ask a question
- **Intelligent navigation** — AI understands your question and jumps to the right slide
- **Continuous listening** — no push-to-talk button required

## Requirements

- **Chrome or Edge** (Azure Speech SDK requires these browsers)
- **Microphone** access
- Azure OpenAI resource (GPT-4o-mini deployment)
- Azure Cognitive Services Speech resource

## Setup

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your Azure credentials
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AZURE_OPENAI_ENDPOINT` | e.g. `https://your-resource.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | Your Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT` | Model deployment name (e.g. `gpt-4o-mini`) |
| `AZURE_SPEECH_KEY` | Azure Speech Services key |
| `AZURE_SPEECH_REGION` | e.g. `eastus` |

## Architecture

```
Browser (React + Vite)
  ├── Azure Speech SDK (browser)    ← TTS + STT, runs client-side
  ├── WebSocket /ws                 ← real-time AI responses
  └── REST /generate-slides         ← slide generation

FastAPI Backend
  ├── /speech-token    → exchanges Azure key for 10-min auth token
  ├── /generate-slides → GPT-4o-mini generates slide JSON
  └── /ws (WebSocket)  → AgentSession handles voice interaction
       ├── CancellationToken  → interrupt mid-stream
       ├── slide narration    → reads speaker_notes directly
       └── user Q&A           → LLM decides navigate_to + response
```

## How Interruption Works

1. Azure STT fires `recognizing` event while the AI is speaking
2. Frontend calls `synthesizer.stopSpeakingAsync()` immediately
3. `{type: "interrupt"}` sent over WebSocket
4. Backend sets `CancellationToken.cancel()` — LLM stream exits at next chunk
5. User's recognized speech is sent as a new `user_input` message

## Voice States

| State | Orb Color | Meaning |
|-------|-----------|---------|
| `idle` | dim purple | Not started |
| `presenting` | purple breathing | Starting up |
| `speaking` | purple pulsing + rings | AI narrating |
| `listening` | green breathing | Waiting for user |
| `thinking` | yellow spinning | Processing user input |
