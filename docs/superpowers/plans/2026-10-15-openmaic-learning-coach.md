# OpenMAIC Learning Coach Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Replace meta-learning with flat OpenMAIC learning skills + export-schedule; remove PPT from agent tools.

**Architecture:** Allowlisted SKILL.md files under `skills/<id>/` are sanitized and inlined into `skill-library.ts` for `read_skill`. Schedule cards use a new core `export_schedule_image` tool on local cache. PPT tools stay in repo but are unregistered from `coreTools`.

**Tech Stack:** TypeScript, AI SDK tools, existing schedule-svg/png renderers.

---

### Task 1: Flatten skills + delete meta-learning

- [ ] Move `skills/openmaic/*/` → `skills/<id>/` (keep LICENSE + provenance README in `openmaic/`)
- [ ] Delete `skills/meta-learning/`
- [ ] Remove meta-learning from `package-skill.mjs` / tests / docs

### Task 2: Allowlist + rebuild skill library

- [ ] Rewrite `SKILL_SOURCES` to 6 learning + export-schedule; path = `skills/<id>/`
- [ ] Add dropSections for curriculum-planner / ZPD as needed so sanitize passes
- [ ] Rebuild `src/core/skill-library.ts`; update `tests/skill-library.test.ts`

### Task 3: Prompt + remove learning/PPT from agent surface

- [ ] Replace 学习教练 block with short routing; remove PPT capability bullets
- [ ] Unregister `learningTools` and `pptTools` from `coreTools`; delete `learning.ts` / `tools/learning.ts`
- [ ] Soften document tool copy that pushes ppt_save

### Task 4: export_schedule_image core tool

- [ ] Add `src/core/tools/schedule-image.ts` using local cache + renderScheduleImage
- [ ] Register in coreTools; mention in basePrompt / school prompts as needed
- [ ] Tests for happy path + missing cache

### Task 5: Docs + verify + PR

- [ ] Update README / capabilities
- [ ] Run typecheck + relevant tests
- [ ] Push branch and open PR
