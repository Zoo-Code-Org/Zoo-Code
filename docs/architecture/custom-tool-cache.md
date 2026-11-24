# Custom tool cache

`CustomToolRegistry` compiles TypeScript tools into a private cache. JavaScript tools load from their source files.

On POSIX systems, the default root is `<os.tmpdir()>/dynamic-tools-cache-<uid>`.
On Windows, the default root is `<os.homedir()>/dynamic-tools-cache-user`.
Windows rejects an explicit `cacheDir` because this implementation cannot verify its ACLs.

The root, entry directories, and bundles must pass the ownership, mode, type, and link checks before reuse.
The registry also checks ancestors. A root-owned ancestor is allowed. Writable ancestors require the sticky bit.
Unsafe roots fail closed. The registry does not change their permissions or delete their contents.

The source path and source mtime determine each entry path. The key starts with `v2:`.
This version excludes older entries that can contain a bundle without complete environment files.
Older entries stay on disk until `clearCache()` removes them from a validated root.

The registry uses one disk lookup path. It does not keep a second map of bundle paths.
Node already caches imported ES modules by URL. Deleting a disk entry causes the next load to rebuild it.
The rebuild does not clear Node's module cache or rerun an already imported module.
`clearCache()` followed by a reload does not force code to run again at the same URL.
A source mtime change produces a new bundle URL. Restarting the process also clears Node's module cache.

A build writes the bundle under a unique temporary name. Each environment file uses a temporary name too.
The registry copies each environment file, sets mode `0600`, validates it, and renames it.
During a build, an unreadable `.env` or `.env.*` file now fails the tool load.
The old code logged a warning and continued. This is an intentional behavior change.
A directory without environment files can still load.
The registry publishes `bundle.mjs` only after all required copies succeed.
The bundle rename is the commit marker. Failed attempts remove their temporary files.
A stopped process can leave temporary files. The next attempt uses new temporary names.
These rules cover process interruption. They do not guarantee durability after power loss.
The review concern G3 about Windows rename failures remains unverified. No Windows reproduction was supplied.
This change adds no Windows-specific rename retry or replacement fallback. Rename errors fail the load.

A failed directory load does not update its successful-load timestamp. A later stale-load call checks it again.
A recognized syntax diagnostic in the entry source is recorded against that file's mtime.
An unchanged source returns the same failure without another compiler call. A source mtime change allows another build.
The registry checks cache paths before it uses a recorded source failure.
Dependency-resolution errors, diagnostics in other source files, and unknown compiler errors remain retryable.
The compiler classification uses uncolored CLI diagnostics. An unrecognized diagnostic stays retryable.
`clearCache()` clears these timestamps and recorded source failures. It continues after an entry fails to delete.
A concurrent clear can still fail an active build. Publication checks the directory again and fails closed.
A later load can retry after the root is safe. The registry does not repair unsafe permissions automatically.

The older `<os.tmpdir()>/dynamic-tools-cache` root is not used or removed automatically.
It can contain old environment file copies. After all older extension versions stop, the user can remove that root.
The registry does not follow an unverified legacy path to delete those files.

The design follows these references:

- [Node ESM caching](https://nodejs.org/download/release/v23.11.1/docs/api/esm.html): Node caches modules by URL.
- [Node filesystem API](https://nodejs.org/api/fs.html): `copyFile` does not guarantee an atomic copy.
- [SQLite atomic commit](https://sqlite.org/atomiccommit.html): a final commit point separates preparation from committed state.

The SQLite reference guides the commit-marker design. This cache does not implement SQLite's durability or locking protocol.
`CustomToolCache.tla` checks publication and path rules. `CustomToolCacheRecovery.tla` checks retry, deletion, and cleanup rules.
Both models check abstractions. The filesystem tests check their correspondence with the runtime.
