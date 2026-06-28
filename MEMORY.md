# MEMORY.md — project notes & decisions

Durable context for the `claude-usage-statusbar` extension. Newest-relevant first.

## Key decision: live API, not local log estimation

- **v0.1 (abandoned):** estimated usage by summing weighted tokens from `~/.claude/projects/*/*.jsonl`
  against configurable budgets. It did **not** match Claude Code's `/usage` (observed 215% / 21% vs.
  real 68% / 69%). Root cause: Anthropic computes the real percentages server-side (weighting models
  and messages differently than a raw token sum), and **no local file stores the real percentages**.
- **v0.2 (current):** reads the real numbers from the live usage endpoint. Verified to match `/usage`.

## The usage endpoint (the important find)

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken from ~/.claude/.credentials.json>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

Response (relevant fields):
- `five_hour.utilization` → **Session %**, `five_hour.resets_at`
- `seven_day.utilization` → **Weekly %**, `seven_day.resets_at`
- `limits[]` entries with `group: "session" | "weekly"`, `percent`, `severity`, `resets_at` (fallback)
- Also present (often null on this plan): `seven_day_opus`, `seven_day_sonnet`, `extra_usage`, `spend`.

## Verified facts about local Claude state

- `~/.claude/.credentials.json` → `claudeAiOauth`: `accessToken`, `refreshToken`, `expiresAt` (ms),
  `scopes`, `subscriptionType`, `rateLimitTier`.
- `~/.claude.json` stores the rate-limit **tier** only (`oauthAccount.organizationRateLimitTier`), not
  current usage.
- `~/.claude/projects/*/*.jsonl` lines carry `timestamp`, `type`, and (for `type: "assistant"`)
  `message.usage` token counts — but **no** rate-limit fields.
- There is **no** `claude usage` CLI subcommand; `/usage` is a TUI-only command backed by the endpoint above.

## Environment notes

- This machine has **no standalone `node`**. Use `ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium`
  (Node v22 bundled with VSCodium) to run/syntax-check JS.
- VSCodium extensions dir: `~/.vscode-oss/extensions/`. Installed copy of this extension lives there
  and is separate from this source repo — re-copy + reload after edits.

## Status

- v0.2.0 installed and verified live (Session/Weekly match `/usage`). Pending: user must
  **Developer: Reload Window** to load the updated build.
