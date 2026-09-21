---
name: spec
description: Turn a persisted hypothesis or raw idea into an owner-approved GitHub issue.
---

Resolve $ARGUMENTS from PRODUCT.md when it is H<n>, including the full card, score, and notes; if missing or ambiguous, report that instead of inventing the idea. For raw text, pass it as such. Delegate product Mode B with this bounded context and relevant existing issues.

Present the resulting spec and request `approve`, edits, or `drop`. Do not create issues until the owner approves that spec. Edits require approval of the revised result.

Before creation, check PRODUCT.md issue links and search existing open and closed GitHub issues for the hypothesis ID and matching scope. Reuse a matching issue; reconcile materially different existing scope with the owner rather than create duplicates. On partial creation failure, retain successful URLs and recheck before retrying.

Create approved issues using `gh issue create --title "<title>" --body-file <tmp> --label agent-ready` with real multiline body text. For an approved split, create one per part, include order and hypothesis ID, and label only the first agent-ready. Persist resulting URLs beside the hypothesis in PRODUCT.md (or a durable spec record there for raw ideas), then report URLs. Do not start implementation.
