# Security

## Reporting a vulnerability

Report a vulnerability privately, through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**. Don't open a public issue for it.

Include what is affected (the compiler, the runtime, or a `node:` module such as `node:tls` or
`node:crypto`), a program or input that shows the problem, and the visaljs version. You'll get
an answer within a week.

## Supported versions

visaljs is before 1.0: only the latest release gets security fixes. A fix to the runtime reaches
a program only when the program is compiled again with the fixed release.

## Scope

A program visaljs builds contains visaljs's runtime and the third-party code it ships
([`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)). A vulnerability in that code, as visaljs
builds and uses it, is in scope. A vulnerability in the program's own code is not.
