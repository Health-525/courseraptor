<div align="center">

# 🦖 CourseRaptor

<img src="docs/courseraptor-logo.png" width="104" alt="CourseRaptor mascot" />

[![CI](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Health-525/courseraptor?label=release&color=orange)](https://github.com/Health-525/courseraptor/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Health-525/courseraptor?style=social&v=2)](https://github.com/Health-525/courseraptor)

**An open-source AI timetable and todo assistant for university students. Import your timetable, then ask about classes, deadlines and your week.**

[Download for Windows](https://github.com/Health-525/courseraptor/releases/latest) · [First use](#first-use) · [Source and demo](#source-and-offline-demo) · [简体中文](README.md)

</div>

<p align="center"><img src="docs/screenshots/demo-overview.png" width="960" alt="Current CourseRaptor interface with conversations on the left, chat in the center and the feature hall on the right" /></p>

<p align="center"><sub>Actual current-source interface with isolated fictional data. The feature hall and its panels open in the right sidebar. No AI calls were made for these screenshots.</sub></p>

Your timetable, deadlines and notes often live in different places. CourseRaptor brings the timetable you import, todos you record and knowledge you save into one assistant, so you can ask about them without searching each app.

Start with questions such as “Where are my classes on Wednesday?” or “Remember to submit my lab report by 3 pm on Friday.” Personal records and generated files are stored locally. **Live AI conversations require your own model API key; relevant content is sent to that provider and may incur API charges.**

[Features](#features) · [Download and requirements](#download-and-requirements) · [First use](#first-use) · [FAQ](#faq) · [Data and boundaries](#data-and-boundaries) · [For developers](#for-developers) · [Contributing](#contributing)

## Features

- **Classes and schedule changes:** query teaching weeks, times and rooms; edit the local timetable and export an image or `.ics` calendar.
- **Deadline todos:** record a task and due time, then list, update or complete it. Due reminders follow the app’s rules while the main process is running, and one-off / daily / weekly alarms can be set for exact times.
- **Today’s plan:** combine your existing timetable and todos in a conversation, with the underlying records available in the feature hall.
- **Study records:** organize knowledge by course and use on-demand learning skills such as Feynman explanations, exercise diagnosis and spiral review.
- **Course materials:** read local PDF, Word and spreadsheet files, filter data, and generate Word, Excel or PDF documents.
- **Optional entry points:** web and terminal share the same local assistant, with QQ and Obsidian integrations available through additional setup.

Timetable import does not require a school-system adapter. Online grades, exams and university notices depend on the installed adapter; they are not universally available.

<details>
<summary>View the timetable, today, todos and knowledge screens</summary>

These captures show panels in the current main interface's feature-hall sidebar, using fictional timetable, todo and knowledge records. Click a title to view the original.

| [Weekly timetable](docs/screenshots/demo-schedule.png) | [Today's plan](docs/screenshots/demo-today.png) |
|---|---|
| <img src="docs/screenshots/demo-schedule.png" width="440" alt="Timetable sidebar listing fictional classes, times and rooms by weekday" /> | <img src="docs/screenshots/demo-today.png" width="440" alt="Today's sidebar showing fictional class times and status" /> |
| [Deadline todos](docs/screenshots/demo-todos.png) | [Course knowledge](docs/screenshots/demo-knowledge.png) |
| <img src="docs/screenshots/demo-todos.png" width="440" alt="Todo sidebar grouping fictional tasks by deadline and completion" /> | <img src="docs/screenshots/demo-knowledge.png" width="440" alt="Knowledge sidebar with course filters and searchable fictional notes" /> |

</details>

<details>
<summary>Interested in AI industry news?</summary>

Source `main` includes an [AI news skill](skills/ai-news/SKILL.md) for sourced Chinese daily digests, breaking briefs and trends from local collection history. It additionally requires Python 3.11+. Collection accesses configured public sources and reuses the day’s frozen snapshot. There is no Feishu delivery. Check release notes before assuming an existing installer contains it; see [configuration](docs/configuration.md#ai-新闻技能).

</details>

## Download and requirements

| Option | Requirements | Where to start |
|---|---|---|
| Windows x64 desktop app | Windows 10/11; Node.js is bundled; bring a model API key for live use | [Latest release](https://github.com/Health-525/courseraptor/releases/latest), asset ending in `desktop-win-x64-setup.exe` |
| Windows x64 portable app | Node.js is bundled; bring a model API key for live use | The same release, asset ending in `portable-win-x64.exe` or `.zip` |
| Source on Windows / macOS / Linux | Node.js 24+, Git and a network connection for dependencies | [Source and offline demo](#source-and-offline-demo) |

Current prebuilt packages target Windows x64. Use source on macOS or Linux. GitHub’s **Source code** archives are not Windows installers. Optional features have additional requirements: Chinese PDF output needs a suitable Chinese font, and AI news needs Python.

## First use

1. **Start the app and configure a model.** Open the desktop app after installation, or follow the portable package instructions. In the feature hall, open Settings → AI model, save your own API key and test the connection. DeepSeek is the default; other built-in providers and compatible custom endpoints are supported.
2. **Import and check your timetable.** Choose Import / Re-import timetable in Settings. Paste text or upload Excel, CSV, PDF, Word or TXT. Check weeks, periods and rooms in the editable preview before confirming.
3. **Complete two small tasks.** Ask for this week’s timetable and verify one class. Then record a deadline and check its exact date and time in the todo list.

If you are not ready to configure an API key, view the screenshot above or run the [key-free offline demo](#source-and-offline-demo) with Node.js. The [student guide](docs/student-guide.md) has more detail in Chinese.

### Try these requests

| Goal | Example |
|---|---|
| Find a classroom | List my Wednesday classes this week, with times and rooms. |
| Record a deadline | Remember to submit my lab report by 3 pm on Friday. |
| Check tasks | What todos have I not completed? |
| Review today | Combine my timetable and todos into today’s plan. |
| Export a timetable | Export an image of this week’s timetable. |
| Save a study note | Save this knowledge point under Calculus. |

Reminders require the main app to keep running and notification permissions to be available; QQ push additionally requires a configured bot and recipients. You can transfer exported images or import `.ics` files on your phone. There is no ready-to-use mobile app or default cloud sync between devices.

## Source and offline demo

**Prerequisites: Node.js 24+ and Git.** Dependency installation needs a network connection; the offline demo needs no API key.

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm ci
npm run demo
```

Open the URL printed in the terminal, normally `http://127.0.0.1:3211`. This demo uses fictional data and scripted answers. It does not call an AI service, read personal credentials or save demo conversations into your personal history. It demonstrates the interface, not model performance. Stop it with `Ctrl+C`.

For live use:

```bash
npm run doctor
npm start
```

Configure the model and import your timetable in the UI. The web address is usually `http://127.0.0.1:3210`; follow the actual startup address and keep the main process running. If you already have a DeepSeek key, `npm run demo:live` offers real model responses against fictional tool data and may incur API charges.

## FAQ

<details>
<summary>Why does it need setup?</summary>

This is an open-source assistant that runs on your computer. Installers bundle the runtime, but live AI use still requires choosing a provider, configuring your own key and importing your timetable. It is not a hosted free-chat service. Use the timetable panel when you just want to inspect existing classes without starting a model conversation.

</details>

<details>
<summary>What if my school is missing, or the import is wrong?</summary>

Use the general timetable import workflow. Include course names, weekdays, periods, teaching weeks and rooms where possible, and correct the preview before saving. Check term dates against your school calendar. Import does not automatically enable online grades, exams or notices; these require the corresponding adapter.

</details>

<details>
<summary>What if startup or the model connection fails?</summary>

See the [student guide](docs/student-guide.md) and [configuration reference](docs/configuration.md). From source, run `npm run doctor` for local prerequisites; it does not check model-account balances. Windows packages are unsigned and may trigger an unknown-publisher prompt: verify the download source and decide whether to run them. Report reproducible problems using an [Issue](https://github.com/Health-525/courseraptor/issues/new/choose), without passwords, API keys or full personal logs.

</details>

## Data and boundaries

- **Stored locally, with model requests online.** Conversations, timetables, todos and knowledge are stored on your computer. Prompts, relevant results and material content needed for AI responses are sent to your chosen provider. Local-first does not mean fully offline processing.
- **Credentials are stored separately.** API keys are encrypted locally. Share a repository link or a clean installer rather than a project folder you have already used.
- **Entry points share local state.** A QQ allowlist does not provide separate student accounts. For independent personal data, each user should install and configure their own instance.
- **Check important results.** This is an unofficial personal tool. Verify class changes, exams and other important arrangements against official university channels, and review parsed or generated content.

See [SECURITY.md](SECURITY.md) for network, attachment and credential details.

## For developers

CourseRaptor is also a runnable reference for building local agents. Technical details live here so students can focus on getting started.

| Area | Starting point |
|---|---|
| Model and tool loop | [`src/core/agent.ts`](src/core/agent.ts) |
| Tool registration | [`src/core/tools/`](src/core/tools/) |
| Provider assembly | [`src/core/providers.ts`](src/core/providers.ts) |
| Session and long-term memory | [`src/core/memory/`](src/core/memory/) |
| School capabilities and ports | [`src/core/school.ts`](src/core/school.ts) |
| On-demand skills | [`skills/`](skills/) and [`src/core/tools/skill-library.ts`](src/core/tools/skill-library.ts) |
| Desktop and Obsidian entry points | [`desktop/`](desktop/) · [`obsidian/`](obsidian/) |

The core uses TypeScript and the Vercel AI SDK, with a Node HTTP web server. Dependencies point inward: `local → channels → core`, checked in CI. Most personal state uses local JSON; AI news additionally uses a local SQLite database for collection history and caching. No database service is required.

```bash
npm run check          # Types, lint and import boundaries
npm run test:coverage  # Full tests and coverage gates
```

Timetable image export can also be [packaged as a standalone skill](skills/export-schedule/package/README.md). Learning-skill attribution and licenses are in [`skills/openmaic/`](skills/openmaic/); AI news provenance is in the [engine notice](scripts/ai-news/NOTICE.md).

## Documentation and contributing

<a id="contributing"></a>

[Student guide](docs/student-guide.md) · [Configuration](docs/configuration.md) · [Capabilities](docs/capabilities.md) · [Obsidian plugin](obsidian/README.md) · [Roadmap](docs/roadmap.md)

Tell us which campus task you repeat, and where installation, model setup or timetable import gets in the way. Use the [Issue form](https://github.com/Health-525/courseraptor/issues/new/choose) for reproducible problems, [Discussions](https://github.com/Health-525/courseraptor/discussions) for use cases, and [CONTRIBUTING.md](CONTRIBUTING.md) for code or documentation contributions.

If it helps you, a star or a link shared with another student helps others find the project.

## License

[MIT](LICENSE). The project is intended for personal learning, research and technical exchange, not commercial or profit-making use. Provided “as is”, without warranty.
