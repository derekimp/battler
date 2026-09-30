# Security

battler runs AI command-line tools on your machine with your accounts, and `battler serve` runs a local web
server, so security reports matter to us.

**Please don't open a public issue for a vulnerability.** Report it privately through GitHub's
[security advisories](https://github.com/derekimp/battler/security/advisories/new) instead. We'll reply as soon
as we can and credit you in the fix unless you'd rather not be named.

Things we especially want to hear about:

- a way for a web page to start battles or read results from `battler serve` (it should refuse cross-site,
  wrong-host and, with `--lan`, token-less requests),
- a way for model output to run scripts in the web app, the reports or the extension panel,
- an API key reaching a CLI despite battler removing them, or a CLI getting write access to your files.
