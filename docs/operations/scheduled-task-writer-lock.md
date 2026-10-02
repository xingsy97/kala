# Scheduled-task writer lease recovery

Each runtime Unit has exactly one scheduled-task writer. Startup opens the
dedicated `<sessionsDir>/.scheduled-tasks/lease.sqlite` database and holds a
SQLite `BEGIN EXCLUSIVE` transaction for the writer's lifetime. A second local
process cannot acquire that transaction and fails readiness. The JSON state
format remains unchanged in `state.json`; the lease database stores no task
state.

The SQLite transaction is backed by operating-system file locks. Graceful close
releases it, and process exit or forced termination closes the database handle
so the OS releases it automatically. There is no PID check, timeout, lock
steal, owner nonce, or stale lock file to remove.

## Dedicated blue/green cutover

1. Stop the old Unit gracefully.
2. Wait for it to finish its active scheduler tick and exit, which closes the
   lease database.
3. Start the replacement Unit.

Do not overlap old and new writers against the same sessions directory. The new
Unit is intentionally not ready until the old writer has released ownership.

## Crash recovery

A replacement can start after the crashed process has exited; no manual lease
cleanup is required. `lease.sqlite` is persistent infrastructure and must not be
deleted as a recovery procedure. If acquisition remains busy, treat that as
evidence that another local writer is still alive and investigate it rather
than stealing the lease.

If startup fails because scheduled-task state is corrupt, repair or restore
`state.json` before restarting. Corrupt state remains a fatal readiness error,
but the failed startup closes its lease so a repaired Unit can restart.

## Storage boundary

The scheduled-task directory must be private to one Unit and on a local
filesystem whose SQLite locking is supported by Node on Linux, macOS, or
Windows. Network or multi-host shared filesystems, including NFS, are not a
supported coordination mechanism. Do not configure two hosts against the same
directory and do not infer multi-host safety from a successful SQLite open.
Deployments that cannot guarantee Unit-private local storage must fail closed
at provisioning/configuration time or use a separately designed coordinator;
the Host does not fall back to a global service or Gateway lock.

Older versions created `writer.lock`. The current Host does not consult that
file. Remove a leftover file only as an upgrade cleanup after proving all old
Host versions using that directory have stopped; it is not part of current
crash recovery.
