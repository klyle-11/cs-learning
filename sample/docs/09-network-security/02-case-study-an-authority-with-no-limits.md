# Case study: an authority with no limits

Two real incidents on one machine, a year apart, with the same shape. The first was found only because the second was. Read [HTTPS and certificates](01-https-and-certificates.md) first.

## What happened

**July 2025.** A web project needed `https://localhost`, because the service it logged in through would only redirect to an `https` address. An AI coding agent proposed three commands, and each was approved:

```
brew install mkcert
mkcert -install
mkcert localhost
```

The app worked. Nobody thought about it again.

**October 2026.** This project's own server needed HTTPS so a phone could use it. It made its own authority, and the phone and laptop installed it. A code review later the same day noticed that the authority could sign for any name, and that its private key sat on disk.

Checking the laptop for other hand-trusted authorities turned up the one from July 2025: also unlimited, also with its key on disk, trusted for every website for fifteen months.

## The shared mistake

Look at what `mkcert -install` does, in the terms of section 4 of the first lesson:

- It creates an authority with **no limits** on what it may sign.
- It stores the authority's **private key in your home folder**, readable by anything running as you.
- It adds the authority to the **system trust store**, for every site, for every browser.

The tool is honest about it. Its documentation says the key file "gives complete power to intercept secure requests from your machine". But the command is one word long, and it was one of three lines in a suggestion whose stated purpose was "make localhost work".

The hub's first version did the same thing by hand, for the same reason: the goal was "make HTTPS work", and an unlimited authority is the shortest path to that.

**The lesson is about the question, not the tool.** "Does it work?" was answered yes both times. "What can this key do, and who can reach it?" was not asked.

## What made it hard to see

- **It worked.** A security weakness produces no error. The padlock appeared, which looks like *more* security.
- **The dangerous step was small.** One flag among several commands, each individually reasonable.
- **It was approved in a hurry.** The agent's commands were confirmed one after another, in the middle of fixing something else.
- **Nothing ever showed it again.** A trust store is not something you look at. There is no notification for "you have trusted a home-made authority for a year".
- **No log.** Operating systems do not record which certificates were accepted, so afterwards there is no way to prove nothing happened. Only how unlikely it was.

## How bad was it, really

For either authority to be abused, someone needed two things: a copy of the private key, and a position on the same network as a device that trusted it.

- On the laptop, anyone who could read the key already had the user's account. The key added little.
- On a phone that trusted the authority, it added a lot: the phone had no other weakness, and now a file on a different machine could unlock all its HTTPS traffic.

So: low likelihood, high consequence, and no way to check afterwards. That combination is the one worth removing even when nothing has gone wrong.

## What was done

1. **A new authority that can only vouch for the hub**, with the all-powerful key never stored (lesson 1, sections 5 and 6).
2. **Tested by attack**: certificates were forged with the stolen-key scenario and checked to be refused, with a control that showed the old design accepting the same forgery.
3. **The old authority removed** from each device by hand. No server can do that part.
4. **The hub's own computer taken out of the picture**: it uses `http://localhost`, so it needs no authority at all.
5. **Written down**: what is installed where, in a table, with fingerprints (`CERTIFICATES.md`).

## Questions to work through

1. `mkcert -install` and "install this profile on your phone" are the same act. What exactly is that act, in one sentence?
2. Why did moving the laptop to `http://localhost` make it *more* secure than HTTPS with the home-made authority, even though it is "less encrypted"?
3. The old key existed for ten hours on one laptop. List what you would need to know to decide whether to change your passwords. Which of those can be known?
4. An agent proposes `curl https://example.com/setup.sh | sudo sh`. Apply the two questions. What would you want to read before approving?
5. Suppose the authority *must* be unlimited (some tools give no choice). What three things would reduce the risk?

<details><summary>Notes on the answers</summary>

1. Telling the device to believe anything that key signs.
2. A connection from a machine to itself cannot be intercepted on the network, so encryption protects nothing there, while the authority added a new way in. Less mechanism, less to go wrong.
3. Whether the key was copied (cannot be known for certain; can check backups, sync, git), whether anyone was positioned on the network (cannot be known), what was sent from the trusting device in that time (you know this). The decision rests on likelihood.
4. What the script does, whether it changes trust stores, startup items or system settings, and what it downloads next. The pipe means you approve code you have not seen.
5. Keep its key off the machine once the certificates are made; install it only on devices that need it; remove it when the project ends. And write down that it exists.

</details>
