# HTTPS and certificates, from zero

What a browser means by "secure", what a certificate is, and what you are really doing when you install a certificate authority. Written after the hub's own authority turned out to be able to vouch for any website (see [the case study](02-case-study-an-authority-with-no-limits.md)).

## 1. What HTTPS gives you

Plain HTTP sends text over a TCP connection. Anything between the two ends (the Wi-Fi access point, another laptop on the same network, the router) can read it and can change it.

HTTPS is the same HTTP, sent through TLS. TLS gives three separate things, and it helps to keep them apart:

- **Confidentiality.** Nobody in between can read what is sent.
- **Integrity.** Nobody in between can change it without the change being noticed.
- **Authentication.** You know *who* is at the other end.

The third one is what everything below is about. The first two are worthless without it: an encrypted, tamper-proof connection to an impostor is still a connection to an impostor. The impostor decrypts what you send, reads it, and passes it on to the real server over a second connection. That is a *man-in-the-middle* attack.

## 2. How a server proves who it is

Each server has a **key pair**: a private key it keeps secret, and a public key anyone may see. What one signs, the other verifies. So a server can prove it holds a private key without revealing it.

That proves "I hold the key matching this public key". It does not prove "I am `example.com`". Anyone can make a key pair.

A **certificate** closes that gap. It is a small document that says: *this public key belongs to these names*, and it is signed by someone else. It contains, among other things:

- the public key
- the names and addresses it is for (the "subject alternative names": this is what browsers check)
- the dates between which it is valid
- who signed it (the issuer), and the signature

Look at one. This shows the hub's own:

```
openssl x509 -in ~/.config/hub/cert.pem -noout -text | less
```

A certificate is encoded in DER, which is nested type-length-value records: exactly the format in [the TLV parser lesson](../04-security/tlv-parser.md). `openssl asn1parse -in ~/.config/hub/ca.pem` prints the raw structure.

## 3. Why believe the signer: the chain of trust

A certificate signed by a stranger proves nothing. So who signs?

A **certificate authority** (CA) is a key pair whose whole job is signing other certificates. Your operating system and browser ship with a list of about a hundred and fifty authorities they trust: the *trust store*. When a server presents its certificate, the browser checks:

1. Is it signed by an authority in my trust store, or by something that is itself signed by one? (This run of signatures is the **chain**.)
2. Is the name I typed among the names in the certificate?
3. Are the dates current?

If all three hold, you get the padlock. If not, the warning page.

```
your trust store ──contains──▶ authority ──signed──▶ (intermediate) ──signed──▶ server's certificate
                                                                                   names: example.com
```

Public authorities such as [Let's Encrypt](https://letsencrypt.org/how-it-works/) only sign a certificate for a name after you prove you control that name. That is the whole value of the system: the padlock means *some authority checked that the holder of this key controls this name*.

## 4. What "installing an authority" really means

When you add an authority to a device's trust store, you are telling that device:

> Believe anything this key signs.

Not "trust this one server". **Anything.** If that authority signs a certificate saying its holder is your bank, your device will show the padlock for it.

So the questions to ask about any authority you are asked to install are:

- **Who holds its private key, and where is it stored?** Whoever can copy that key can sign anything.
- **Is it limited in what it may sign?** Most home-made ones are not.

A private, home-made authority is how local development tools and home servers get HTTPS without a public name. It is a reasonable thing to do. It is also the single most powerful thing you can add to a device, and tools make it a one-line command.

## 5. Limiting an authority: name constraints

A certificate can carry an extension called **name constraints**: a list of names and addresses its holder may sign for. Anything outside the list is refused by the browser, even though the chain leads to a trusted authority.

The hub's authority carries:

```
X509v3 Name Constraints: critical
    Permitted:
      DNS:local
      DNS:localhost
      IP:127.0.0.0/255.0.0.0
      IP:10.0.0.0/255.0.0.0
      IP:192.168.0.0/255.255.0.0
      ...
```

"Critical" means software that does not understand the extension must refuse the certificate outright. So it fails safe: the worst case on an old device is that the hub does not open.

With that in place, someone who steals the signing key can pretend to be the hub, or another device on a private network. They cannot pretend to be a website.

## 6. The hub's chain, and why it has three parts

```
ca.pem          the authority a device installs. Its private key signs ONE thing,
   │            then is thrown away. It was never written to disk.
   ▼
issuer.pem      the only thing the authority ever signed. Carries the name constraints.
   │            Its key is kept (issuer-key.pem), because it has to keep signing.
   ▼
cert.pem        what the server presents. Re-made when the machine's address changes.
```

Two protections stack here:

- The key that could sign for anything **no longer exists**. There is nothing to steal.
- The key that does exist is **limited** by its constraints.

The first does not depend on how any particular device treats constraints on an installed authority. The second is belt and braces.

In code this is `ensure_certs` in `server-cpp/src/secure.hpp`. The constraint extension is written out byte by byte there, because the library has no call for it: a short, real example of producing DER by hand.

## 7. Secure contexts: why the reader wants HTTPS at all

Browsers only allow certain features on a connection they consider secure: service workers (opening with the server off), the built-in cryptography (encrypting the copies on the device), and others. This is the [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) rule.

Two things count as secure:

- `https://` with a certificate the device trusts
- `http://localhost`, because that connection never leaves the machine

That second rule is why the computer the hub runs on needs no authority installed at all, and why a phone does.

## 8. Things to try

1. Print the hub's three certificates and find the issuer and subject of each. Which one has `CA:TRUE, pathlen:1`? Which has no `CA:TRUE`?
   ```
   for f in ca issuer cert; do openssl x509 -in ~/.config/hub/$f.pem -noout -subject -issuer; done
   ```
2. Watch a handshake and see which certificates the server sends:
   ```
   openssl s_client -connect localhost:4321 -showcerts </dev/null
   ```
   Why is `ca.pem` not among them?
3. On your Mac, list the certificates whose trust was changed by hand: `security dump-trust-settings -d`. For each one, answer the two questions in section 4.
4. Forge one. With the issuer's key, sign a certificate for `example.com` and check that it is refused. `CERTIFICATES.md` in the repository's top folder records this test and its result; reproduce it before reading how.

## Before next time

- TLS gives confidentiality, integrity and authentication. Without the third, the first two protect a conversation with the wrong party.
- A certificate binds a public key to names, and is only as good as whoever signed it.
- Installing an authority means "believe anything this key signs". Ask who holds the key and whether it is limited.
- Name constraints limit an authority to a list of names and addresses.
- `http://localhost` is already a secure context.

Further reading: [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446) (TLS 1.3), [RFC 5280, section 4.2.1.10](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.10) (name constraints), [Certificate Transparency](https://certificate.transparency.dev/) (how publicly issued certificates are logged so mis-issued ones can be spotted).
