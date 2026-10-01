# Repository instructions

- Never use the word `ensure` in code
- Never use `void` in TypeScript
- Do not write new smoke tests or unit tests
- For validation, port and run Azahar's existing native tests, including the native fixtures in its pinned dependencies
- Preserve upstream test cases and expected results when adapting their build or execution harness for Wasm
- Commit completed feature or fix slices frequently after their relevant checks pass, following the commit-hygiene skill
- Keep each commit focused on one change; do not defer completed changes until the end of a long task
