## ISSUE-028: Documentation Improvements

Goal
----

Create a concise, discoverable documentation section covering:

- Project overview and high-level architecture
- How to run tests and CI locally
- Compatibility matrix explanation and interpretation
- Contribution guide for plugins and integrations

Initial checklist
-----------------

- [ ] Write 'Project overview' (README extraction)
- [ ] Add 'Running tests' and developer setup
- [ ] Document `compatibility/` reports and CI lanes
- [ ] Create CONTRIBUTING.md with PR/review instructions
- [ ] Ship docs in docs/ and link from README

Proposed next steps
-------------------

1. Extract short architecture blurb from README and place under `docs/overview.md`.
2. Add `docs/developer-setup.md` with `pnpm` + Node 22 setup steps and common troubleshooting notes.
3. Document `compat-pinned` vs `compat-latest` behavior in `docs/compatibility.md` and show an example report.
4. Draft `CONTRIBUTING.md` with branch naming, conventional commits, and external-review workflow.

Contact
-------

If you'd like a specific doc first (e.g., CONTRIBUTING.md), say so and I will draft it next.
