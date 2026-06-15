# Horus agent workflow (HOR-54)

This document is the authoritative reference for how Claude, Codex, and Reporter
agents coordinate on the Horus Linear board. All future agent loop prompts must
agree with this document.

---

## Board columns

| Column | Meaning |
|---|---|
| **Backlog** | Not yet scheduled — agents must not pick from here |
| **Todo** | Ready to be claimed — Claude picks from here only |
| **In Progress** | Actively being implemented — at most one Claude ticket |
| **In Review** | Implementation done, uncommitted — Codex picks from here |
| **Done** | Committed, pushed, validated — only Codex moves issues here |

---

## Agent roles

### Claude — implementer

Claude writes code and documentation. It does not commit, push, or mark work Done.

**Rules:**

1. Only pick from **Todo**.
2. Work on **at most one ticket at a time**.
3. Before claiming: open the full issue, read `blockedBy` / `relations`.
4. If any blocker is not in Done state, **skip the ticket** — no comment, no move.
5. After claiming: move to **In Progress**, post the claim comment.
6. Implement the smallest correct change that satisfies the ticket.
7. Run validation (tests + typecheck) before marking done.
8. If validation fails or blocked: keep In Progress, post a blocker comment, stop.
9. If complete:
   - **Do not** run `git add`, `git commit`, or `git push`.
   - Leave all file changes uncommitted in the working tree.
   - Post the implementation summary comment (see template below).
   - Move issue to **In Review**.
10. Stop. Do not pick another ticket in the same cycle.

**Claim comment template:**
```
Claude picked this up for implementation. I checked blockers and found none open.
```

**Completion comment template:**
```markdown
## Implementation summary

What changed:
* ...

Files/modules touched:
* ...

Validation:
* ...

Git status:
* Uncommitted changes left for Codex review

Risks / notes:
* ...

Ready for Codex review.
```

---

### Codex — reviewer, committer, Done owner

Codex reviews code correctness, commits, pushes, and closes tickets.

**Rules:**

1. Only pick from **In Review**.
2. Read the implementation summary comment left by Claude.
3. Inspect the uncommitted diff.
4. Validate: tests pass, typecheck clean, behavior matches ticket.
5. If changes are needed: move back to **In Progress**, comment with specific feedback.
6. If approved: `git add`, `git commit`, `git push`.
7. Move issue to **Done**.
8. Codex is the only agent that moves issues to Done.

---

### Reporter — observer only

Reporter reads board state and summarizes progress. It never touches code or Linear.

**Rules:**

1. Read board columns and issue comments.
2. Summarize completed work, In Review queue, and blockers.
3. Post to Slack (or designated channel) on a scheduled cadence.
4. **No code edits**, **no Linear edits**, **no git operations**.

---

## Blocker checking

Before claiming any Todo ticket:

1. Open the full issue (`get_issue` with `includeRelations: true`).
2. Read the `blockedBy` array.
3. For each blocker: check its current state.
4. If **any blocker is not in Done**: skip this ticket silently. Do not comment, do not move.
5. Move to the next Todo candidate.

A ticket in In Review is **not Done** — it still blocks dependents.

---

## Single-active-ticket discipline

At any point in time, Claude may have **at most one** In Progress ticket.

Before claiming a new Todo ticket, Claude checks In Progress:
- If a Claude-claimed ticket is there → continue that ticket or skip the cycle.
- If nothing is there → pick the highest-priority unblocked Todo ticket.

This prevents parallel In Progress tickets and ensures Codex always gets clean,
reviewable diffs for one change at a time.

---

## Priority order for Todo candidates

1. Priority label: Urgent → High → Medium → Low
2. Oldest `createdAt` (or `updatedAt`) within the same priority
3. Smallest/safest scope (documentation < test-only < code change)

---

## Cycle summary (Claude)

```
Check In Progress
  └─ Claude ticket in progress?
       ├─ Yes, this session owns it → continue implementation
       ├─ Yes, another session owns it → skip cycle
       └─ No → inspect Todo
            └─ Sort by priority / age / scope
                 └─ For each candidate:
                      ├─ Open full issue
                      ├─ Check blockedBy (all must be Done)
                      ├─ Blocked? → skip, next candidate
                      └─ Unblocked? → claim, implement, validate, In Review, stop
```
