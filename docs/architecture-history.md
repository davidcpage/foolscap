# Architecture history (provenance)

*Extracted from `CLAUDE.md` on 2026-07-07 as part of the harness-constitution trim
(`docs/harness-constitution.md`): history/provenance that doesn't change how an agent acts, moved out of
the always-loaded `CLAUDE.md` into a pullable reference.*

## Origin — de-risking spikes

This began as a series of de-risking spikes: a store-only benchmark (which picked signia), a render-edge
proof (60fps at N=5000), and two renderer proofs (a React reference and a Solid port, demonstrating
swappability over the unchanged engines). They were removed once their conclusions landed; `app/` is the
renderer that grew out of them.

## Renderer swappability

Swappability was demonstrated once by a Solid port (its entire delta was one `src/reactive.ts`) and then
retired — demonstrated, not maintained. React was chosen for momentum and ecosystem, and the choice stays
cheap to reverse because the engines never learned about the renderer.
