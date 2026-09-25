// Normalize only tar's host-specific listing presentation; callers still
// require exact target-qualified member names before trusting an archive.
export function tarEntries(listing) {
  return new Set(listing.split(/\r?\n/u).filter(Boolean).map((entry) => entry.replaceAll('\\', '/')))
}
