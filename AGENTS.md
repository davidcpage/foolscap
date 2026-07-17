# AGENTS.md

**This file is a pointer. The single source of truth for working on this repo's code is
[`CLAUDE.md`](CLAUDE.md).**

AGENTS.md used to be a near-verbatim fork of CLAUDE.md; two copies drift, and this one already had — its
dev-ops section still documented the pre-supervisor workflow after the supervisor landed. To keep one
source of truth, the content now lives only in CLAUDE.md — architecture, packages, build & test, conventions, size
caps & truncation, dev-ops (`npm run dev` / the supervisor / the session-host sidecar), and the
where-things-live implementation map.

How a session *behaves on the board* — the norms and the exact API usage — is NOT in either file; it's the
**harness**: `app/harness.md` (the always-loaded constitution) plus the on-demand recipe leaves in
`app/harness/*.md`.
