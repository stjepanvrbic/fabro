# The factory fork of fabro

This repository is stjepanvrbic's fork of [fabro-sh/fabro](https://github.com/fabro-sh/fabro),
the platform underneath the factory (see the factory repo's `docs/factory.md`).
Work happens directly on `main`. The diff against upstream is kept as small as
the factory's features allow; upstream PRs are opportunistic.

## Building from source

```bash
bun install                                        # JS workspace deps
cargo run -p fabro-dev --features dev -- spa refresh   # build web UI, embed into fabro-spa
cargo build -p fabro-cli                           # the fabro binary (server + CLI)
target/debug/fabro server start --foreground       # run it
```

## Local server setup (headless, no wizard)

The install wizard normally writes `~/.fabro/settings.toml`, seeds a default
environment row in the storage database, and provisions secrets. Standing the
server up by hand needs the same three pieces:

- `~/.fabro/settings.toml` with `[server.listen]` (TCP), `[server.web]`,
  `[server.auth] methods = ["dev-token"]`, and `[run.environment] id = "local"`
  — the server auto-creates a `local` environment row; any other id must exist
  in the environments table or run creation fails with
  "failed to resolve manifest settings".
- `SESSION_SECRET` and `FABRO_DEV_TOKEN` in the server's process environment
  (kept in `~/.secrets/fabro/server.env`, symlinked at `~/.fabro/server.env`).
- Provider API keys in the fabro vault (`fabro secret set <NAME>`), referenced
  as `vault:<NAME>` from `[llm.providers.<id>.auth].credentials`. Custom model
  entries require `family`, `limits`, and `features` or the catalog build
  fails at startup.

For LLM-credential-free smoke testing, `test/twin/openai` (`cargo run
--release`, binds 127.0.0.1:3000) is an OpenAI-compatible fake with
deterministic fallback responses; register it as an `openai_compatible`
provider and route a workflow's model to it.

Note: the running server's process title is `fabro server tcp:<addr>` (argv is
rewritten), so match that — not `fabro server start` — when killing it.

## Known upstream test flake

Three `fabro-server` tests (`serve::tests::build_object_store_*`,
`serve::tests::build_slatedb_store_*`,
`install::tests::write_artifact_store_metadata_*`) fail only in the full
parallel run: `install.rs` sets the process-global
`FABRO_TEST_IN_MEMORY_STORE` env var mid-suite and concurrent storage tests
observe it. Present on unmodified upstream (verified at 3226d845 with the
fork diff stashed); each passes alone and with `--test-threads=1`. Upstream
candidate fix: scope the var with a guard or mark those tests serial.

Similarly, 14 `apps/fabro-web` bun tests (build-version guard, import-chunk,
run-files rendering) fail on this box identically with and without the fork
diff (verified with the diff stashed); the fork's own suites are green.

## Rebasing onto an upstream release

The fork tracks upstream tagged releases at our choosing (no standing
`upstream` remote; fetch ad hoc):

```bash
git fetch https://github.com/fabro-sh/fabro.git main --tags
git tag --sort=-creatordate | head          # pick the release to move to
git rebase <tag> main                       # replay fork-only commits onto it
cargo test --workspace                      # fork must stay green
git push --force-with-lease origin main
```

Conflicts are resolved in favor of keeping the fork diff minimal: if upstream
grew an equivalent of a fork feature, drop the fork commit and adopt upstream's.
