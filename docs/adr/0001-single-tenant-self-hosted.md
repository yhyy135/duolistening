# Single-tenant, self-hosted — no accounts

Status: superseded by [ADR 0008](0008-browser-owns-all-state.md), which reaches the same
goal by removing the server-side state rather than by isolating it per user.

This is an open-source project distributed for people to run themselves, not a multi-tenant SaaS we operate. Each deployment (the deployer's own machine or their own server) serves exactly one person: one global settings file, one LLM API key, no login/session system, no per-user data isolation.

We considered a true multi-tenant model (one shared deployment, many accounts, data isolated per user) and a middle ground (one shared deployment behind a single access password, still no per-user data). Both were rejected for now: multi-tenancy is an order of magnitude more work (auth, sessions, per-user data model) with no near-term need — anyone wanting to serve multiple people can just run their own instance instead.

Because the backend can be deployed to a public server (not just localhost), the instance still gets one minimal safeguard: a single shared password/token set via an environment variable. The frontend asks for it once, stores it, and sends it on every request; the backend checks it as a pass/fail gate. This is not a user system — there is still exactly one identity — it only stops a stranger who finds the URL from spending the owner's LLM budget or reading their data.
