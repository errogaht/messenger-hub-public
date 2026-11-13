# Security and private data

Keep configuration, bearer tokens, keys, profiles, journals, provider sessions,
media and ASR receipts outside Git with restrictive permissions. Bind the Hub to
loopback; use server-side scopes for each client. A scope does not isolate a
malicious process running as the same OS user. Plugins are trusted local code.

Report vulnerabilities privately to the repository maintainer through GitHub's
private vulnerability reporting when available. Do not attach real messages,
credentials, account IDs, databases or provider exceptions to public issues.

Only the current source snapshot is maintained. Production deployments and
provider-specific bridges require operator review. Tests use fake transports;
never test message sends against clients. Unknown write outcomes must be
reconciled rather than blindly retried.

For a public release use the curated source export, never the private working
repository or its history. Secret scanners cannot certify absence of personal
information; review examples, documentation and generated artifacts as well.
