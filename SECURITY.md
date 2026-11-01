# Security

## Supported versions

Security fixes go into the newest release, published as the `main-latest` image. Please
update to it before reporting a problem.

## Reporting a vulnerability

Please don't report security problems in public issues. Instead, open a
[confidential issue](https://git.nico.software/1n9i9c7om/nicotes/-/issues/new?issue[confidential]=true)
(the "This issue is confidential" box is ticked by the link), so only the maintainers can
read it.

A good report says which version you run (Settings → About), what an attacker can do, and
the steps to reproduce it. Once a fix is released, the issue is made public and the
changelog mentions the fix.

## Running Nicotes safely

Nicotes is built for one person (or a household) on their own server. A few settings matter
when it can be reached over the internet:

- **HTTPS.** Run it behind a reverse proxy that serves HTTPS, publish the container port on
  localhost only, and set `NICOTES_SECURE_COOKIES=true`.
- **Your own password.** Nicotes refuses to create the first account with the example
  password from `.env.example`. Failed sign-ins are rate-limited.
- **Secrets.** API keys saved in Settings are encrypted with a key in the data volume, or
  with `NICOTES_SECRET` if you set it. Backups contain that key, so keep them as private as
  the data itself.
- **Imports.** Web imports refuse addresses on private networks to keep the server from
  being used against your own network. `NICOTES_IMPORT_ALLOW_PRIVATE=true` turns that off;
  only use it if you trust everyone who can sign in.
- **Browser extension.** `NICOTES_BROWSER_EXTENSION=true` lets browser extension pages show
  Nicotes in a frame. Leave it off if you don't use the sidebar.
- **AI features.** With an OpenRouter or Routeway key, the text of the notes a feature works
  on is sent to that service. Nothing is sent without a key.
