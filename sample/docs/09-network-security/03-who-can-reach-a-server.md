# Who can reach a server, and what a browser will do for a stranger

HTTPS is one layer. This lesson is about the others: which machines can connect at all, what other websites can make your browser do, and how a server tells its own page from someone else's. Each idea is shown in the hub's server, `server-cpp/src/hub.cpp`.

## 1. Listening: 127.0.0.1 or 0.0.0.0

A server *binds* to an address when it starts. That one choice decides who can connect.

| Bound to | Who can connect |
|---|---|
| `127.0.0.1` (localhost) | Programs on this machine only. The packets never reach a network card. |
| `0.0.0.0` | Anyone who can reach any of this machine's addresses: everyone on the Wi-Fi, and on some networks more. |

In C, it is the address passed to `bind`:

```c
struct sockaddr_in addr = {0};
addr.sin_family = AF_INET;
addr.sin_port = htons(4321);
inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);   /* or "0.0.0.0" */
bind(fd, (struct sockaddr *)&addr, sizeof addr);
```

Many development servers bind to `0.0.0.0` by default, or when given a flag such as `--host`. On a café network that publishes your half-built app, with no login, to the room. Check with:

```
lsof -iTCP -sTCP:LISTEN -n -P
```

`*:4321` or `0.0.0.0:4321` means the whole network; `127.0.0.1:4321` means this machine only. The hub binds to `127.0.0.1` unless started with `npm run start:network`.

## 2. Knowing who is asking: pairing and tokens

Being reachable is not the same as being allowed. The hub answers only devices it has been introduced to:

1. A paired device (or the terminal) produces a short **pairing code**, good for ten minutes and five tries.
2. The new device sends the code and receives a long random **token**.
3. The server keeps only a *hash* of the token. Every later request must carry the token.

Three details matter and recur in every login system:

- **Store a hash, not the secret.** Someone who reads the server's file cannot use what they find.
- **Compare in constant time.** A comparison that stops at the first wrong character leaks, through timing, how much was right.
- **Limit the tries.** A short code is safe only because it stops working after five wrong guesses.

## 3. Cookies, and what the flags mean

The hub's own page keeps its token in a cookie set like this:

```
Set-Cookie: hub_device=...; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=31536000
```

| Flag | What it stops |
|---|---|
| `HttpOnly` | Scripts in the page reading the cookie. A script that should not be there cannot steal it. |
| `Secure` | The cookie being sent over plain HTTP, where it could be read. |
| `SameSite=Strict` | The browser attaching it to requests that other websites cause. |

A cookie is *ambient*: the browser attaches it automatically. That is convenient and it is the root of the next problem.

## 4. Other websites can make your browser send requests

Your browser will happily send a request to `http://localhost:4321/api/notes` because a page on `evil.example` asked it to. If the cookie is attached, the server sees a properly logged-in request. That is **cross-site request forgery** ([CSRF](https://owasp.org/www-community/attacks/csrf)).

The [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy) stops the other site *reading the answer*. It does not stop the request being *sent*, and for a request that deletes or changes something, sending is enough.

Defences, all used by the hub:

- `SameSite` cookies, so the cookie is not attached.
- The server checks the `Origin` and `Sec-Fetch-Site` headers, which the browser sets and a page cannot fake, and refuses anything that did not come from its own page.
- For the one case where another origin is welcome (a reader loaded from a different hub), the token must be sent explicitly in an `Authorization` header. A page can only do that if it *has* the token. [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) is the mechanism by which the server says such a request may read the answer.

The general rule: **ambient authority (cookies, "it came from this machine") must never be honoured for a request another site could have caused.**

## 5. DNS rebinding: when "same origin" is a lie

The same-origin policy compares *names*. An attacker controls the DNS for their own name, so they can make `evil.example` resolve to `192.168.1.20`, your server's address. Now a page loaded from `evil.example` is, to the browser, the same origin as your server. This is [DNS rebinding](https://en.wikipedia.org/wiki/DNS_rebinding).

The defence is on the server: look at the `Host` header and refuse any name that is not one of your own. In the hub that is `known_host`: `localhost`, the machine's names and addresses, and nothing else.

## 6. Content that tries to act

A document is data until the browser treats it as a program. A markdown file containing `<img src=x onerror="...">`, or an uploaded HTML page with a script, would run with the reader's full access.

Two layers, because either can fail:

- **Sanitise** what is inserted into the page (the hub uses DOMPurify).
- A **[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)** header that says what the page may do at all: scripts from this server only, no inline handlers, connections to this server only. With it, a sanitiser slip is not fatal, and opening a document can never contact the internet.

The same header is why a document cannot tell a third party what you are reading: an image on another site is simply not loaded.

## 7. Things to try

1. Run `lsof -iTCP -sTCP:LISTEN -n -P` now. For each line, say who can connect.
2. Start the hub with `npm start`, then with `npm run start:network`. Compare the two `lsof` lines.
3. From a terminal, pretend to be another website and watch the refusal:
   ```
   curl -i -H 'Origin: http://evil.example' http://localhost:4321/api/notes
   ```
4. Pretend to be a rebinding page:
   ```
   curl -i -H 'Host: evil.example' http://localhost:4321/api/config
   ```
5. Read the headers the page itself is sent: `curl -sI http://localhost:4321/ | grep -i content-security`. Find the part that stops a document loading a picture from another site.
6. In `hub.cpp`, find `cross_site`, `known_host` and `device_of`. For each, write one sentence: what attack would work if this function always returned "fine"?

## Before next time

- The bind address decides who can connect; `0.0.0.0` means everyone who can reach the machine.
- Store hashes of secrets, compare in constant time, limit tries.
- A cookie is sent automatically, so another site can borrow it unless `SameSite` and an origin check prevent that.
- The same-origin policy trusts names; the server must check the `Host` it is addressed by.
- Sanitise, and also set a policy that limits the damage when sanitising fails.
