<div align="center">

<img src="docs/hero-banner.png" width="100%" alt="CourseRaptor, an open-source academic assistant featuring a friendly dinosaur mascot" />

# CourseRaptor

### Less time navigating academic portals. More time for student life.

**An open-source academic AI assistant for Nanjing Tech University students.**

[简体中文](README.md) · **English**

[![Checks](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml) [![ISC License](https://img.shields.io/badge/License-ISC-8f2b21)](LICENSE) [![Node 24+](https://img.shields.io/badge/Node.js-24%2B-8f2b21?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/download)

[Try the demo](#try-it-without-credentials) · [Discuss](https://github.com/Health-525/courseraptor/discussions) · [Contribute](CONTRIBUTING.md)

</div>

CourseRaptor brings timetables, grades, exams, academic announcements, and calendar exports into one conversational interface. Use the browser or terminal, with an optional QQ bot connection.

**The current academic-system integration supports Nanjing Tech University only.** This is an independent, unofficial project. The product interface and most documentation are in Chinese; this English overview helps developers understand and contribute to the project.

## What it does

| Student question | Available capability |
|---|---|
| Where are my classes this week? | Timetables by semester and teaching week, including odd/even weeks and recorded schedule adjustments |
| How am I doing academically? | GPA, earned credits, failed courses, and grades requiring confirmation |
| Which general elective categories have I covered? | Passed-course category summaries to help check your own curriculum requirements |
| When are my exams? | Exam subjects, dates, times, rooms, and seat information |
| What does this announcement require me to do? | Announcement lists, full text, and supported attachments |
| Can I use my phone calendar? | Local `.ics` export; optional publication to a public GitHub/Gitee subscription source |
| Can I turn this material into a document? | Local document/table reading and Word, Excel, PowerPoint, and PDF generation |

![Real browser UI displaying a fictional timetable in offline demo mode](docs/screenshot-demo.jpg)

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

## Use your own academic account

Run `npm start`, or double-click `start.bat` on Windows. Follow the prompts to configure your own university credentials and DeepSeek API key. Provider API usage may incur charges.

The browser UI usually runs at `http://localhost:3210`; follow the actual startup address if that port is busy. Keep the terminal running. To change your API key securely, enter `/key` without arguments in the terminal.

## Boundaries that matter

- Local hosting does **not** mean fully offline processing: prompts and relevant query results are sent to the configured model provider.
- Category coverage is not a graduation audit. Check requirements for your own program and enrollment year.
- Local calendar export does not require publication. The current subscription implementation publishes to a **public repository**, so confirm the disclosure of course locations and times.
- QQ users share the configured university identity; the allowlist is not multi-student account isolation.
- Real course-enrollment submission is disabled by default. Follow university rules and confirm actions before enabling it.
- Planned reminders, schedule-change notifications, curriculum audits, and additional university integrations are **not yet implemented**.

Share the repository URL or an inspected clean installation package, never your used project directory. See [privacy and security](SECURITY.md).

## Build with us

TypeScript, Vercel AI SDK, DeepSeek, and a Node HTTP browser interface. University adapters live in `src/jwgl/`, tool schemas in `src/tools/`, and the production/demo shared view in `src/web/chat-page.ts`.

```bash
npm run typecheck
npm run lint
npm test
```

[Contributing](CONTRIBUTING.md) · [Roadmap](docs/roadmap.md) · [Capabilities](docs/capabilities.md) · [Student guide](docs/student-guide.md)

Found it useful? A star, a reproducible issue, or a concrete student use case helps the project improve.

Released under the [ISC License](LICENSE). No official affiliation with or endorsement by Nanjing Tech University.
