<div align="center">

<img src="docs/courseraptor-logo.png" width="160" alt="CourseRaptor logo: a flat three-color raptor with round glasses" />

# CourseRaptor

### Less time navigating academic portals. More time for student life.

**An open-source conversational academic agent — currently fully adapted for Nanjing Tech University (NJTECH), usable at other schools via manual timetable import.**

[简体中文](README.md) · **English**

[![CI](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml)
[![ISC License](https://img.shields.io/badge/License-ISC-8f2b21)](LICENSE)
[![Node 24+](https://img.shields.io/badge/Node.js-24%2B-8f2b21?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/download)
[![GitHubDaily](https://img.shields.io/badge/GitHubDaily-Featured-1DA1F2?logo=x&logoColor=white)](https://x.com/github_daily/status/2105560876132757969)
[![Indie Dev List](https://img.shields.io/badge/China_Indie_Dev_List-Featured-9B59B6)](https://github.com/1c7/chinese-independent-developer/blob/master/.github/pages/README-Programmer-Edition.md)

[Try the demo](#try-it-without-credentials) · [Quick start](#use-your-own-academic-account) · [Discuss](https://github.com/Health-525/courseraptor/discussions) · [Contribute](CONTRIBUTING.md)

</div>

CourseRaptor brings timetables, grades, exams, academic announcements, and calendar exports into one conversational interface. Ask in the terminal, the browser, or QQ — three entrances sharing one agent kernel and one memory store. Everything runs on your own machine: credentials are AES-256-GCM encrypted on disk, and it talks to your own model API key — DeepSeek by default, with 10 more built-in Chinese providers (Qwen, Zhipu GLM, Kimi, Doubao, Hunyuan, MiniMax, Step, ERNIE, Spark, SiliconFlow) plus custom OpenAI-compatible endpoints. The installer sends one anonymous ping per day (random device id + version, for install counting only, disable with `RAPTOR_NO_TELEMETRY=1`); running from a git clone sends nothing.

> ⚠️ **The online academic-system integration supports Nanjing Tech University only.** This is an independent, unofficial project. The product interface and most documentation are in Chinese; this English overview helps developers understand and contribute to the project. The [Chinese README](README.md) is the authoritative, fully detailed version.

## What it does

| Student question | Available capability |
|---|---|
| Where are my classes this week? | Timetables by semester and teaching week, including odd/even weeks and recorded schedule adjustments |
| How am I doing academically? | GPA, earned credits, failed courses, and grades requiring confirmation |
| Which general elective categories have I covered? | Passed-course category summaries to help check your own curriculum requirements |
| When are my exams? | Exam subjects, dates, times, rooms, and seat information |
| What does this announcement require me to do? | Announcement lists with per-grade relevance, full text, and cached attachments (spreadsheet filtering, paginated document reading) |
| Can I use my phone calendar? | Local `.ics` export; optional publication to a public GitHub/Gitee subscription source |
| Can I turn this material into a document? | Local document/table reading and Word, Excel, PowerPoint, and PDF generation with cross-format conversion |
| My school is not NJTECH | Manual timetable mode: paste timetable text or upload Excel/CSV/PDF/Word/TXT, and the AI parses it into a structured timetable |

The agent ships **36 tools** (32 loaded by default — the four course-grabbing tools are real write operations, disabled unless `RAPTOR_ENABLE_GRAB=1`, and always require in-chat confirmation). See [capabilities](docs/capabilities.md) for the full table. A headless CLI ([`skills/njtech-jwgl/`](skills/njtech-jwgl/SKILL.md)) exposes the same academic queries for scripting without touching the LLM.

Both screenshots below use fictional demo data.

**Terminal TUI** — type `raptor` to chat; the first screen shows today's classes, todos, upcoming exams, and latest notices:

<p align="center"><img src="docs/screenshots/tui.png" width="800" alt="Terminal TUI welcome panel: classes, todos, exams and notices (fictional demo data)"></p>

**Web chat** — open `http://localhost:3210` in a browser; reasoning and tool calls are visible in the conversation:

<p align="center"><img src="docs/screenshots/gui.png" width="800" alt="Web chat: reasoning card, tool calls and timetable reply (fictional demo data)"></p>

## Try it without credentials

Install Node.js 24 or later, then:

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm ci
npm run doctor
npm run demo
```

Open the URL printed in the terminal, normally `http://127.0.0.1:3211`.

The demo uses **fictional data and scripted responses**. It does not read personal credentials, contact the university or an AI provider, or persist conversations to disk. It demonstrates the interface, not live AI performance. Press `Ctrl+C` to stop.

To showcase real AI analysis with the same fictional data, run `npm run demo:live` instead. It answers with a real DeepSeek model (requires a `DEEPSEEK_API_KEY` in the environment or the project `.env`; API usage may incur charges) while every tool still returns fictional samples, so no account or personal data is involved. Without a key it falls back to the scripted offline demo.

## Use your own academic account

Windows users can grab a self-contained installer (bundled Node runtime, ~110 MB) from [Releases](https://github.com/Health-525/courseraptor/releases/latest) — no development environment needed. From source, run `npm start` (or double-click `start.bat` on Windows). Follow the prompts to configure your university credentials and model API key (DeepSeek by default; other providers can be switched in the web Settings panel). You can also skip the campus account with an empty Enter and fill it in later via the web Settings panel. Provider API usage may incur charges.

The browser UI usually runs at `http://localhost:3210`; follow the actual startup address if that port is busy. Keep the terminal running. To change your API key securely, enter `/key` without arguments in the terminal.

## Architecture overview

- **Agent runtime**: Vercel AI SDK v7 (`ToolLoopAgent` + `runAgentTUI` for terminal)
- **LLM**: DeepSeek by default (`deepseek-flash` / V4.1-Flash), switchable to 10 more Chinese providers or a custom OpenAI-compatible endpoint — each provider's key stored and hot-swapped independently
- **Academic protocol**: Custom NJTECH 正方新版 adapter (RSA + CSRF login; course selection reverse-engineered from official frontend)
- **Web UI**: Single-page Node server (`src/channels/web/`) with push-panel layout, session history, and real-time tool result sync
- **Ports and adapters**: `src/core/school.ts` defines the `SchoolAdapter` port; core never imports adapters, so adding a school means adding one self-contained directory under `src/adapters/`
- **Data storage**: Local JSON files only (`data/`, `session.json`, `memory.json`, `credentials.enc`); no database, no cloud sync

## Project structure (key directories)

```
├── bin/raptor.cjs        # Global CLI entry (npm link)
├── docs/                 # Assets & extended docs
├── skills/njtech-jwgl/   # Headless academic-query skill (no LLM, no tokens)
├── src/
│   ├── core/             # School-agnostic kernel: agent, memory, calendar,
│   │                     # documents, attachments, knowledge + generic tools
│   ├── adapters/
│   │   ├── njtech/       # NJTECH implementation: login, schedule, grades,
│   │   │                 # exams, course selection, notices + school tools
│   │   └── custom/       # Other schools (manual timetable mode)
│   └── channels/web/     # Web UI: chat, hall, /today, /todos, /knowledge
└── local/                # Entrypoints: cli (TUI), qq (bot bridge), demo
```

## Boundaries that matter

- Local hosting does **not** mean fully offline processing: prompts and relevant query results are sent to the configured model provider.
- Category coverage is not a graduation audit. Check requirements for your own program and enrollment year.
- Local calendar export does not require publication. The current subscription implementation publishes to a **public repository**, so confirm the disclosure of course locations and times.
- QQ users share the configured university identity; the allowlist is not multi-student account isolation.
- Real course-enrollment submission is disabled by default. Follow university rules and confirm actions before enabling it.
- Planned reminders, schedule-change notifications, curriculum audits, and additional university integrations are **not yet implemented**.

Share the repository URL or an inspected clean installation package, never your used project directory. See [privacy and security](SECURITY.md).

## Supported schools

| University | Capabilities | Adapter maintainer |
|---|---|---|
| [Nanjing Tech University](src/adapters/njtech/) (NJTECH) | All online capabilities | [@Health-525](https://github.com/Health-525) |

Other schools work through the manual timetable mode (paste or upload a timetable and let the AI parse it). Your school not listed? [Request an adapter](https://github.com/Health-525/courseraptor/issues/new?template=request-school.yml) with a few details, or [write one yourself](docs/adapter-guide.md) — adapters are self-contained, Zhengfang-based systems have a full reference implementation to copy from, and merged PRs carry your name as that school's maintainer.

## Build with us

TypeScript, Vercel AI SDK, a multi-provider model layer (DeepSeek default + OpenAI-compatible providers), and a Node HTTP browser interface. School adapters live in `src/adapters/` behind the `SchoolAdapter` port (`src/core/school.ts`), generic tools in `src/core/tools/`, and the production/demo shared view in `src/channels/web/`.

```bash
npm run typecheck
npm run lint
npm test
```

[Contributing](CONTRIBUTING.md) · [Roadmap](docs/roadmap.md) · [Capabilities](docs/capabilities.md) · [Student guide](docs/student-guide.md)

Found it useful? A star, a reproducible issue, or a concrete student use case helps the project improve.

Released under the [ISC License](LICENSE). No official affiliation with or endorsement by Nanjing Tech University.
