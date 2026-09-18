# Security Policy

NEXUS is a portfolio project under active development and is not yet intended for production use.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately to the repository owner
(use GitHub's "Report a vulnerability" feature on the repository's Security tab once it is
published). Include steps to reproduce and the affected version or commit. You can expect an
acknowledgement within a few days.

## Scope and design

The security model, threat model and implementation status are documented in
[docs/security.md](docs/security.md). Secrets are supplied only through environment variables and
must never be committed; `.env.example` contains development placeholders only.
