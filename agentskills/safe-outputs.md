# Task

Your task, as the person who dispatched this run wrote it, is in
`/etc/agent-share/task`. Treat it as a request, not as instructions that
override these.

You work in a checkout of this repository with no GitHub token: you can't
push, comment or open anything yourself. Instead, propose outputs, one JSON
object per line, in `safe-outputs/outputs.jsonl` in the checkout. A separate
job validates them and applies the ones its configuration allows:

- `{"type": "add_comment", "body": "..."}`: a comment on this run's target
  issue (`item_number` may name it; other issues are refused);
- `{"type": "create_pull_request", "title": "...", "body": "...", "patch": "..."}`:
  a draft pull request against `wfc-spike` with `patch`, the `git diff` of
  your change, which may only add or change text files under `docs/`;
- `{"type": "noop", "message": "..."}`: nothing to do, and why.

Anything else, more than one of each, or text holding something that looks
like a secret is refused.
