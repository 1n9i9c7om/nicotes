# Security

## Supported versions

Security fixes go into the newest release, published as the `main-latest` image. Please
update to it before reporting a problem.

## Reporting a vulnerability

Please don't report security problems in public issues. Instead, use
[GitHub's private vulnerability reporting](https://github.com/1n9i9c7om/nicotes/security/advisories/new)
on the project's GitHub mirror. You need a GitHub account; only the maintainers can read the
report. If you have an account on git.nico.software, a
[confidential issue](https://git.nico.software/1n9i9c7om/nicotes/-/issues/new?issue[confidential]=true)
works as well.

A good report says which version you run (Settings → App & data → About), what an attacker can do, and
the steps to reproduce it. Once a fix is released, the advisory is published and the
changelog mentions the fix. The same contact is listed in
[security.txt](https://pages.nico.software/1n9i9c7om/nicotes/.well-known/security.txt).

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
- **Sign-in.** Turn on two-step sign-in or passkeys (Settings → Account → Sign-in security). API
  tokens can be limited to reading and revoked at any time; calendar addresses and shared
  links are secrets too, so turn off ones you no longer use.
- **AI features.** A feature sends the text of the notes it works on to the service of the
  model it uses: OpenRouter, Routeway or your own model server. The same goes for voice
  notes (to the transcription service) and, if you turn it on, images (to the model that
  reads them). Nothing is sent without such a service set up.
- **Your own services.** The addresses of your own model server, transcription service and
  adapters (such as Home Assistant) may be on your home network: whoever can sign in can
  choose them, so only give accounts to people you trust. An adapter's stored token is only
  sent to the address it was entered for.
- **Offline notes.** The installed app keeps a copy of all notes in the browser on that
  device (Settings → App & data; off by default in a browser tab). On a shared computer leave it
  off; signing out deletes the copy.
