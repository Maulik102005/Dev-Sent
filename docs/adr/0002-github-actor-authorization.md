# ADR 0002: authorize actors with repository base permission

- Status: accepted
- Date: 2026-09-01

## Context

A valid GitHub webhook proves payload authenticity, not that its sender may ask
DevSentinel to spend compute, execute repository code, or create a patch. Issue
authors and commenters may have no repository write access.

Authorization needs current GitHub state. Payload fields such as
`author_association` are useful context but are not the durable permission
source for this decision.

## Decision

1. Authenticate as the GitHub App installation identified by the verified
   webhook.
2. Scope the authorization token to the webhook's one repository ID and request
   only `metadata:read`.
3. Call GitHub's repository collaborator-permission endpoint for the sender.
4. Require base `write` permission for both `TEST` and `FIX` by default.
5. Treat `404` as no permission and record `REJECTED`.
6. Refresh the installation token once after `401`.
7. Treat authentication, rate-limit, network, malformed-response, and server
   failures as retryable job failures rather than permission denial.
8. Never store installation tokens in PostgreSQL, Redis payloads, or logs.
9. After the final queue attempt, move the run to `FAILED` with a redacted
   diagnostic rather than leaving it in `AUTHORIZING` indefinitely.

## Consequences

Benefits:

- Permission reflects the actor's current repository access, including grants
  inherited from teams, organizations, or enterprise policy.
- A stolen queue payload cannot provide a GitHub credential.
- A token minted for authorization cannot access unrelated installation
  repositories.
- GitHub outages fail closed without permanently misclassifying the actor.

Costs:

- Each uncached authorization needs GitHub token/API traffic and is subject to
  rate limits.
- Base roles intentionally collapse `maintain` to `write` and `triage` to
  `read`; `role_name` is kept only as evidence.
- Public-contributor workflows will need an explicit approval mechanism rather
  than silently lowering the permission threshold.
- The development allow-all adapter must remain impossible to confuse with a
  production mode.
