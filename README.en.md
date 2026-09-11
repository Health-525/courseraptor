<div align="center">

<img src="docs/courseraptor-logo.png" width="150" alt="CourseRaptor logo" />

# 🦖 CourseRaptor

### An open-source Campus Agent for university life.

Schedules · grades · exams · notices · calendars · files · long-term memory — in one conversation.

> **Currently supports NJTECH.** We're building an adapter architecture for more universities.

**English** · [简体中文](README.md) · [Features](docs/features.md) · [Contributing](CONTRIBUTING.md)

[![ISC License](https://img.shields.io/badge/License-ISC-8f2b21)](LICENSE)
[![Node 24+](https://img.shields.io/badge/Node.js-24%2B-8f2b21?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/download)

</div>

## Demo

![15-second demo: ask about a schedule, relevant notices, and calendar export](docs/demo.gif)

*Every course and notice in this recording is fictional. It contains no student credentials, API keys, or real academic data.*

## Why CourseRaptor?

Campus information is scattered across academic portals, announcement pages, files, and calendars. CourseRaptor connects those tasks to a local conversational Agent: ask what is on tomorrow's schedule, which notices need action, or export an academic calendar without navigating a maze of menus.

It is broader than a timetable lookup script. The project combines academic queries, notice and file handling, document generation, calendar exports, and durable preferences across Web, CLI, and an optional QQ bot.

## Features

| Need | Available capability |
|---|---|
| Academic information | Schedules, grades/GPA, exams, student profile, enrolled courses, and enrollment status |
| Notices and files | University notices and attachments; paged documents and structured Excel/CSV queries |
| Time and calendar | Teaching weeks, recorded holidays and make-up days, weather, `.ics` schedules and exams |
| Student deliverables | Generate or convert Word, Excel, PowerPoint, and PDF files locally |
| Personalization | Short-term conversations and long-term memory; optional QQ bot entry point |

See the [feature reference](docs/features.md) for the complete tool catalog, limitations, and configuration details.

## Architecture

```text
Web / CLI / QQ
      │
CourseRaptor Agent ── tools · memory · files · calendars
      │
University integration
      ├── NJTECH  ✅ supported today
      └── Your university  🧩 adapter architecture in progress
```

The current university integration is in [`src/jwgl/`](src/jwgl/). The intended Adapter boundary isolates university login, schedules, grades, exams, and notices so each integration can be implemented and tested independently. Read [Bring CourseRaptor to Your University](docs/writing-an-adapter.md) for the design direction.

## Quick Start

### Windows portable package

Download the **`portable-win-x64`** zip from [Releases](https://github.com/Health-525/courseraptor/releases/latest), extract it, and run `start.bat`. It includes the Node.js runtime. Configure your own academic account and model API key only when you begin live queries.

### Development

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm ci
npm run doctor
npm start
```

Node.js 24+ is required. Live mode sends prompts and relevant query results to your configured model provider and may incur API charges. Credentials stay with your own local instance. See [configuration](docs/configuration.md).

## University Support

| University | Status | Notes |
|---|---|---|
| Nanjing Tech University (NJTECH) | ✅ Supported | The currently available academic-system integration |
| Other universities | 🧩 Adapter architecture in progress | Please start by sharing the system type, public interface clues, and test scenarios |

Two universities using the same vendor are not automatically compatible. Never share real accounts, cookies, grade reports, or private notice attachments. Each future university integration needs redacted fixtures and independent tests before it is listed as supported.

## Contributing

Want to bring CourseRaptor to your university, improve the student experience, or make the docs clearer? Begin with the [contribution guide](CONTRIBUTING.md), then open a reproducible issue, describe a student use case, or send a focused documentation improvement.

- [Feature reference](docs/features.md)
- [Roadmap](docs/roadmap.md)
- [Adapter design](docs/writing-an-adapter.md)
- [Student guide](docs/student-guide.md)

Released under the [ISC License](LICENSE). CourseRaptor is independent and is not officially affiliated with or endorsed by any university.
