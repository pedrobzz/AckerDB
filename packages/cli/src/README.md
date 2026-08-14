# CLI source map

`index.ts` is the programmatic package entrypoint. The executable is
`commands/main.ts`.

| Module | Owns |
| --- | --- |
| `app/` | Configuration, app discovery/import, code generation, startup, and the OpenAPI export |
| `commands/` | CLI argument dispatch and operational commands |
| `migrations/` | Migration loading, planning, generation, consent, and persistence |

Command parsing should stay separate from the modules that perform the work.
