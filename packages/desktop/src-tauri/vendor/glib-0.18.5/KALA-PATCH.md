# Kala security patch

This is the crates.io `glib` 0.18.5 source with the upstream fix for
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
applied to `VariantStrIter::impl_get`.

The patch changes the GLib out-parameter from `&p` to `&mut p`, matching
gtk-rs-core commit
[`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34).
The vendored source remains under its original MIT license.
