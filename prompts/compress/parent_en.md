Merge the following {n} nodes ({ids}) into ONE **parent node** as structured JSON (output ONLY JSON).
**Always write all field values in English.**
**Scope**: these nodes have no protection marker — they are the merge targets; if any other node in the input carries the {marker} marker, do NOT touch it.
{budget_line}**Merge rules (per field)**:
- summary: integrate the child narratives into one phase narrative (keep the through-line and causality, do not list child events one by one).
- narration: merge the child narrative overviews into **one** plain sentence (roughly 40–80 Chinese characters, keeping the original tone) — for humans to read and for later readers to match the register; do not enumerate the children.
- task: the LATEST state wins (supersede); keep unresolved todos/blockers, collapse completed ones to "done".
- decisions: accumulate and dedupe; keep both still-valid and overturned decisions (note what overturned them); never drop the why.
- lessons: abstract concrete errors/fixes into reusable rules/patterns; keep recurring important errors.
- context: union and dedupe, newest wins on conflicts; **constraints MUST be preserved** (never dropped by level).
- user: merge and consolidate; no duplicates or contradictions.
**Leave fields empty when there is nothing relevant (omitting the field is fine); no placeholders like "none"/"N/A", no fabrication, guessing or repetition just to fill them.**

Please give the compression result (JSON; **never exceed the total length budget stated above**):
