# Releasing evaluation packages and plugins

Release the protocol and SDK as one tested compatibility set. Build and test current source, run contributor clean-workspace acceptance, run governance/boundary checks, then pack and inspect package contents. Publish the protocol before the SDK at the same version. Release notes must name protocol versions, security-impacting changes, required migrations between canonical platform versions, and tested runtime package versions.

Plugin publishers should pin the minimum compatible SDK version, include only built output/public fixtures/docs, use semantic versions, record source revision and checksums, and test installation from the produced tarball. Never publish resolved credentials, private paths, real customer/session data, Host evaluation artifacts, or generated evidence containing private inputs.

Rollback installs the preceding package set and creates fresh runs. It does not read, import, forward, or dual-write pre-cutover Host evaluation state.
