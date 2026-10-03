# Keeping watch

A working routine for not being surprised again. Short on theory; the first three lessons in this folder have that. The specific record for this machine and its devices is `CERTIFICATES.md` in the repository's top folder.

## The two questions

Before approving any command, install or setting that touches trust:

1. **What can this do if it is misused?** Not what it is for; what it *can* do.
2. **Who can reach it?** Which file, which account, which network.

Most mistakes in the [case study](02-case-study-an-authority-with-no-limits.md) came from answering "what is it for" in place of the first question.

## Commands that deserve a pause

These are not forbidden. They are the ones to read twice, especially when an AI agent or a tutorial proposes them as one step among many.

| You see | What it really does |
|---|---|
| `mkcert -install`, `security add-trusted-cert`, "install this profile", "trust this certificate" | Adds a certificate authority: the device will believe anything that key signs |
| `sudo ...` | Runs with the power to change anything on the machine |
| `curl ... \| sh`, `curl ... \| sudo bash` | Runs code you have not seen |
| `--host 0.0.0.0`, `HOST=0.0.0.0`, "expose to network" | Lets everyone on the network connect |
| `--insecure`, `-k`, `verify=False`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, "ignore certificate errors" | Turns off the check that you are talking to the right server |
| `chmod 777`, `chmod -R a+rw` | Lets every account on the machine read and change the files |
| `npm install <something new>`, `pip install`, `brew install` | Runs that package's install scripts as you |
| writing a key or token into a file inside a project | One `git add -A` from being published |
| "disable SIP", "allow apps from anywhere", turning off the firewall | Removes a protection for everything, to fix one thing |

With an agent, the useful habit is to ask it, before approving: *what does this change outside the project folder, and how do I undo it?* If the answer includes a trust store, a system setting or a startup item, write it down.

## Every few months

**Authorities you added by hand**

- Mac: `security dump-trust-settings -d` and `security dump-trust-settings`. Each certificate listed is one you (or a tool) chose to trust. For each: who holds its key, is it limited, is it still needed?
- iPhone: Settings → General → VPN & Device Management, and Settings → General → About → Certificate Trust Settings.
- Windows: `certmgr.msc` → Trusted Root Certification Authorities.
- Android: Settings → Security → Encryption & credentials → Trusted credentials → User.
- Firefox, on any system: Settings → Privacy & Security → Certificates → View Certificates → Authorities.

**What is listening**

```
lsof -iTCP -sTCP:LISTEN -n -P
```

Anything on `*` or `0.0.0.0` that you did not mean to share is a finding.

**Secrets on disk**

- Private keys should be readable by you only: `ls -l` shows `-rw-------`.
- None inside a folder that syncs, and none inside a git repository. `git log --all --oneline -- '*.pem' '*.key' '.env'` in a repository lists any that ever were.
- Know which backups include them.

**Who is paired or logged in**

- The hub: settings → "devices…". Remove what you do not recognise.
- The same habit applies to every account that lists its sessions or devices.

**What tools left behind**

- `brew list` and a look through it for things you no longer use.
- Login items and background items in System Settings.
- Projects you finished: do they have an authority, a paired device, a listening server, a token?

## When something looks wrong

1. **Do not tap through a certificate warning** to "just get it working". The warning is the system doing its job.
2. **Stop the exposure first**: remove the authority, stop the server, revoke the token. Investigate after.
3. **Establish the window**: when did the thing start existing, when did it stop. File dates and certificate dates usually say.
4. **Ask what an attacker would have needed**, and which of those needs you can rule out.
5. **Accept what cannot be known.** Operating systems do not log which certificates were accepted. Decide on likelihood, and change passwords if the consequence would be bad enough to justify the effort.
6. **Write it down**: what it was, when, what was checked, what was done. The next incident is found faster.

## Choosing the less powerful tool

Often the safest fix is to need less:

- A browser on the same machine as the server needs no certificate: `http://localhost` is already treated as secure.
- A server that only you use needs to listen on `127.0.0.1` only.
- A home-made authority can be limited to the names it is for.
- A token can be for one device and removable, in place of a shared password.
- A phone that only reads while at home may not need the features that require HTTPS at all.

Each removes something that could go wrong, in exchange for a feature you may not use.

## The hub's own commands

From `hub/`:

| Command | What it starts |
|---|---|
| `npm start` | This computer only. Nothing to trust, nothing exposed. |
| `npm run start:network` | The network, over HTTPS, with pairing. Other devices need the hub's authority. |
| `npm run start:network:insecure` | The network, **without** encryption. Only on a network you fully control. |
| `npm run cert` | Make or renew the certificates and print the fingerprint. |
| `npm run cert:new-authority` | Replace the authority. Every device then installs the new one. |
| `npm test` | The server's checks, including the refusals described in lesson 3. |

## Before next time

- Ask what a thing *can* do and who can reach it.
- A trust store, a listening address and a key on disk are the three places to look.
- Stop exposure first, then investigate, then write it down.
- Prefer the setup that needs the least.
