# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/andis7419-boop/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/andis7419-boop/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node 22 TypeScript process — no git binary, no dependencies, standard library only. One process serves all four surfaces from its own in-memory store: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under `/api/v3` for repositories, issues, pull requests and contents; GraphQL v4 at `/api/graphql`; and MCP (JSON-RPC 2.0 Streamable HTTP) at `/mcp`. Everything is deterministic: all timestamps come from `MAKEFUN_TRIAL_NOW` (or the fixed scenario epoch), all ids are sequential counters, and request ids are monotonic (`req-1`, `req-2`, …), so a trial replay leaves a byte-identical state export.

## Run it

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the trial environment at `$MAKEFUN_ENV_URL`, and exits 0 when the environment reports done. Requests authenticate with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — lifecycle only: bind, register, wait for done, exit 0.
- `src/server.ts` — routing, auth, request ids.
- `src/store.ts` — the single source of truth (repos, refs, objects, issues, pulls, labels).
- `src/git-objects.ts` — SHA-1 objects, pack parse/build, delta application.
- `src/git-http.ts` — upload-pack v2 / receive-pack v0, pkt-line framing.
- `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts` — the three API surfaces.
- `src/util.ts` — deterministic trial clock, counters, base64 helpers.

## Verified

- Sealed local runner: 120/120 conformance checks, perf 126–131 points (reference ≈ 100).
- Full-trial replay (two runs via the kit env + scorer): state export byte-identical; scores 930 and 944 / 1000.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards · Referral: https://make.fun/r/3mkd4a85</sub>
