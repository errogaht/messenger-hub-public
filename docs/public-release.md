# Public source release

Version 0.9.0 is a self-hosted source release under MIT. It requires per-installation
private configuration and separately installed compatible provider bridges. Start
with [installation](installation.md); implemented features and limits are in README.
There is no claim of universal turnkey installation or complete live-provider QA.

The maintained working repository contains private task history and operational
reports. Do not change its visibility, mirror it, push its branches/tags, use
`git archive` on it, or upload its npm package as a public release. Deleting current
files does not remove their previous versions from Git history.

Maintainers build a separate allowlisted export using
`scripts/export-public-release.py DESTINATION --policy PRIVATE_REDACTION_POLICY`.
The destination must not exist. The policy is private and is never copied; it
maps known operator identifiers to synthetic examples and rejects forbidden text.
The exporter includes source, isolated tests, protocol docs, curated installers,
license and notices. It excludes tasks, reports, AGENTS, PROJECT_STATUS, live smoke
scripts, credentials, journals, caches and all original Git metadata.

Run clean `npm ci`, `npm test`, Python fake bridge/core tests, dependency audit,
secret scan and privacy review on that export. Record checks privately. Then create
a NEW repository from the checked export with one clean initial commit and neutral
public commit identity; add only the intended new remote. No original objects,
private author emails, branches or tags should be imported. The prepared source
archive may be shared independently of the private repository.

The export is a release artifact, not a replacement for operational backups. Keep
provider sessions and unresolved write journals with their existing owners.
