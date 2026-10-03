# TLV (Type-Length-Value) Parser with Strict Bounds Checks

> **What this teaches**: The shape of most binary protocols and most parser CVEs in one place. The discipline of "never trust a length field" becomes muscle memory. After this you'll smell a class of vulnerabilities at the bytecode level — Heartbleed, dozens of stack-smashing protocol bugs, every ASN.1 BER/DER mis-parse, every "X parsed an attacker-controlled length field naively" CVE.

**Language**: C
**Effort**: half a day
**Companion reads**: 4.1 length-prefixed string (the simpler ancestor), 4.4 integer overflow detection (the bug class this composes with), CWE-805/823 ("Buffer Access with Incorrect Length Value")

---

## 1. Why this matters

Open any binary protocol spec. You'll find some variant of:

```
+-------+---------+---------------+
| TYPE  | LENGTH  | VALUE (LENGTH bytes) |
+-------+---------+---------------+
```

This pattern — **TLV** (or its cousin TV, or LV, or TLV-with-nesting) — is the dominant shape of binary protocols:

- **X.509 certificates** (and all of ASN.1 BER/DER) → TLV trees
- **TLS records** → 1-byte type + 2-byte length + payload
- **DNS messages** → length-prefixed labels
- **HTTP/2 frames** → 24-bit length + 8-bit type + payload
- **BGP** → marker + length + type + payload
- **DHCP options** → 1-byte tag + 1-byte length + value
- **TIFF / PNG / many image formats** → tag + length + data chunks
- **USB descriptors** → length + type + fields
- **ISO 8583 (banking)** → field tag + length + value
- **Bluetooth GATT, NDEF, CBOR, MessagePack** — variants of the same shape.

And the **parser** for each of these is a recurring source of CVEs. Heartbleed (CVE-2014-0160) was, at its core, "TLS heartbeat parser read the attacker-supplied length field, then `memcpy`'d that many bytes out of the buffer regardless of whether the buffer was actually that long." It's the parser bug class that won't die.

This exercise teaches the **discipline** that prevents that bug, in code small enough to internalize completely.

---

## 2. The mental model

You have a `(buffer, length)` pair from somewhere — a socket read, a file read, an `mmap`. You walk through it advancing a cursor. **Every read must be bounds-checked against the cursor's remaining length.** Not against the buffer's total length. Not against your assumption of what should be left. Against what *actually* remains.

```
buf:     [T][LL][LLLLLLLLLLLL........ rest of file ........]
cursor:  ^
remain:  = buf_len

read T:   need 1 byte, ok, cursor += 1
read LL:  need 2 bytes, ok, cursor += 2
read value: need LL bytes
          *** here is where 90% of CVEs live ***
          if LL > remain - cursor: FAIL — do not memcpy
          cursor += LL
```

The discipline is not complicated. It is just *applied without fail, on every read, with no shortcuts and no assumptions*.

---

## 3. A typed cursor — the right abstraction

The most common mistake is sprinkling `if (i + n > len)` checks throughout the parser, each subtly wrong. The cure is to wrap the buffer in a *cursor* type with safe read primitives. Then every read is bounds-checked **by construction**.

```c
// tlv.h
#ifndef TLV_H
#define TLV_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct Cursor {
    const uint8_t *buf;
    size_t         len;
    size_t         pos;
} Cursor;

static inline Cursor cur_make(const uint8_t *buf, size_t len) {
    Cursor c = { buf, len, 0 };
    return c;
}

static inline size_t cur_remaining(const Cursor *c) {
    return c->len - c->pos;
}

bool cur_read_u8 (Cursor *c, uint8_t  *out);
bool cur_read_u16(Cursor *c, uint16_t *out);   // big-endian
bool cur_read_u32(Cursor *c, uint32_t *out);
bool cur_read_bytes(Cursor *c, size_t n, const uint8_t **out_ptr);
bool cur_skip(Cursor *c, size_t n);

// Sub-cursor over the next `n` bytes; advances parent by n.
bool cur_sub(Cursor *parent, size_t n, Cursor *out_sub);

#endif
```

All read functions return `bool`. `true` = success and cursor advanced. `false` = bounds violation, cursor untouched, caller must abort. **No raw pointer arithmetic in the parser.**

```c
// tlv.c
#include "tlv.h"
#include <string.h>

bool cur_read_u8(Cursor *c, uint8_t *out) {
    if (cur_remaining(c) < 1) return false;
    *out = c->buf[c->pos];
    c->pos += 1;
    return true;
}

bool cur_read_u16(Cursor *c, uint16_t *out) {
    if (cur_remaining(c) < 2) return false;
    *out = ((uint16_t)c->buf[c->pos] << 8) | (uint16_t)c->buf[c->pos + 1];
    c->pos += 2;
    return true;
}

bool cur_read_u32(Cursor *c, uint32_t *out) {
    if (cur_remaining(c) < 4) return false;
    *out = ((uint32_t)c->buf[c->pos    ] << 24) |
           ((uint32_t)c->buf[c->pos + 1] << 16) |
           ((uint32_t)c->buf[c->pos + 2] <<  8) |
           ((uint32_t)c->buf[c->pos + 3]);
    c->pos += 4;
    return true;
}

bool cur_read_bytes(Cursor *c, size_t n, const uint8_t **out_ptr) {
    if (cur_remaining(c) < n) return false;
    *out_ptr = &c->buf[c->pos];
    c->pos += n;
    return true;
}

bool cur_skip(Cursor *c, size_t n) {
    if (cur_remaining(c) < n) return false;
    c->pos += n;
    return true;
}

bool cur_sub(Cursor *parent, size_t n, Cursor *out_sub) {
    if (cur_remaining(parent) < n) return false;
    *out_sub = cur_make(&parent->buf[parent->pos], n);
    parent->pos += n;
    return true;
}
```

Look closely at `cur_remaining(c) < n` and at `cur_remaining(c)`. Both are written so that **no addition can overflow**.

- `c->len - c->pos` cannot underflow because we maintain the invariant `pos <= len` (every successful read advances pos by exactly the amount we just checked we had).
- We compare `remaining < n`, not `pos + n > len`. The latter would overflow on attacker-controlled `n` near `SIZE_MAX` — the exact bug class that has shipped to production for decades.

This is small but **the entire point of the exercise lives here.** Get this right and most TLV parser CVEs become unwritable.

---

## 4. Parsing a flat TLV stream

Now the parser itself. We'll do a simple TLV: 1-byte type, 2-byte big-endian length, value.

```c
// tlv.h additions
typedef struct TLV {
    uint8_t        type;
    uint16_t       length;
    const uint8_t *value;     // pointer into the original buffer
} TLV;

// Parse one TLV from cur. On success: tlv populated, cur advanced past the value.
bool tlv_parse_one(Cursor *cur, TLV *out);

// Parse all TLVs until end of cur. Returns false on malformed input.
typedef bool (*tlv_visit_fn)(const TLV *tlv, void *userdata);
bool tlv_parse_all(Cursor *cur, tlv_visit_fn visit, void *userdata);
```

```c
// tlv.c additions

bool tlv_parse_one(Cursor *cur, TLV *out) {
    uint8_t  t;
    uint16_t len;
    if (!cur_read_u8(cur, &t))    return false;
    if (!cur_read_u16(cur, &len)) return false;

    const uint8_t *val;
    if (!cur_read_bytes(cur, len, &val)) return false;

    out->type   = t;
    out->length = len;
    out->value  = val;
    return true;
}

bool tlv_parse_all(Cursor *cur, tlv_visit_fn visit, void *userdata) {
    while (cur_remaining(cur) > 0) {
        TLV tlv;
        if (!tlv_parse_one(cur, &tlv)) return false;
        if (!visit(&tlv, userdata))    return false;  // visitor aborted
    }
    return true;
}
```

That is the entire TLV-walker, and **it is correct**, because every single read flows through the cursor. There is no opportunity to "forget" a bounds check; the check is baked into the read primitives.

Compare to the broken version that has shipped in many real codebases:

```c
// CVE-flavored anti-pattern
while (i < buf_len) {
    uint8_t  t   = buf[i];           // implicit assumption: i < buf_len
    uint16_t len = (buf[i+1] << 8) | buf[i+2];   // 1 of 3 bugs: i+1 might be == buf_len
    memcpy(out, &buf[i+3], len);     // 2 of 3 bugs: buf[i+3] may be past end
    i += 3 + len;                    // 3 of 3 bugs: i + 3 + len may overflow
}
```

Three bugs in four lines. **All three** are eliminated by the cursor design — not by paying more attention.

---

## 5. The nesting case (where things get real)

Real TLV protocols nest. ASN.1 has constructed types (a TLV whose value is itself a sequence of TLVs). TLS records contain handshake messages which contain extensions. The right pattern for nesting is **bounded sub-cursors**.

```c
// Parse a TLV whose value is itself a sequence of nested TLVs.
bool tlv_parse_nested(Cursor *cur, tlv_visit_fn visit, void *userdata) {
    uint8_t t;
    uint16_t len;
    if (!cur_read_u8(cur, &t))    return false;
    if (!cur_read_u16(cur, &len)) return false;

    // Make a sub-cursor over exactly the value bytes. Advances the parent.
    Cursor sub;
    if (!cur_sub(cur, len, &sub)) return false;

    // Now sub is bounded to the inner range. The recursive parser
    // CANNOT walk past the inner boundary even if its own length fields
    // are lying — sub.len is the truth.
    return tlv_parse_all(&sub, visit, userdata);
}
```

The sub-cursor trick is **structural**. Even if a nested TLV inside `sub` claims a length larger than `sub` allows, the bounds check at the cursor level will refuse the read. The inner parser does not need to know it is nested — its only world is `sub`.

This is how a careful ASN.1 / TLS / HTTP/2 parser is written. Everything is sub-cursored to its parent's length. A malformed inner length cannot corrupt the outer walk because the outer cursor has already advanced past the entire (whatever-it-was) inner blob.

---

## 6. Example: a tiny DHCP-options-style parser

Let's exercise it. DHCP options use 1-byte tag, 1-byte length, value, with a magic end tag.

```c
#include <stdio.h>

#define DHCP_OPT_END    0xff
#define DHCP_OPT_PAD    0x00

static bool dhcp_print_option(const TLV *t, void *userdata) {
    (void)userdata;
    printf("opt %3u len %3u :", t->type, t->length);
    for (uint16_t i = 0; i < t->length; i++) printf(" %02x", t->value[i]);
    putchar('\n');
    return true;
}

bool dhcp_parse_options(const uint8_t *buf, size_t len) {
    Cursor c = cur_make(buf, len);
    while (cur_remaining(&c) > 0) {
        uint8_t tag;
        if (!cur_read_u8(&c, &tag)) return false;
        if (tag == DHCP_OPT_END) return true;
        if (tag == DHCP_OPT_PAD) continue;

        uint8_t opt_len;
        if (!cur_read_u8(&c, &opt_len)) return false;

        const uint8_t *val;
        if (!cur_read_bytes(&c, opt_len, &val)) return false;

        TLV t = { tag, opt_len, val };
        if (!dhcp_print_option(&t, NULL)) return false;
    }
    // Unterminated options block. RFC says we should require an END tag,
    // but real-world parsers usually tolerate truncation. Choose one.
    return true;
}
```

You should *test this with adversarial inputs*. The interesting cases:

- `tag = 5, len = 200, buf has 10 bytes left` → must refuse.
- `tag = 5, len = 0, buf empty after` → must succeed.
- `tag = 5` at the very last byte (no length follows) → must refuse.
- `len = 255` with exactly 255 bytes left → must succeed.
- Buffer of size 0 → must succeed (no options).
- Buffer truncated mid-option → must refuse.

A complete test suite for this parser is *short* — twenty cases — and is the kind of thing that should run on every CI commit.

---

## 7. The "extended length" trap (ASN.1, CBOR, etc.)

Many protocols allow variable-width length encodings: a short form (1 byte) and a long form (multiple bytes). ASN.1 BER famously: if the high bit is set, the low 7 bits give the *number of length bytes*, which follow.

```c
// ASN.1 BER definite-length parser
bool ber_read_length(Cursor *c, size_t *out_len) {
    uint8_t first;
    if (!cur_read_u8(c, &first)) return false;

    if ((first & 0x80) == 0) {
        // short form: length is the byte itself (0..127)
        *out_len = first;
        return true;
    }

    uint8_t n = first & 0x7f;
    if (n == 0)            return false;   // indefinite form, reject
    if (n > sizeof(size_t)) return false;  // length wider than our size_t

    size_t len = 0;
    for (uint8_t i = 0; i < n; i++) {
        uint8_t b;
        if (!cur_read_u8(c, &b)) return false;
        // Detect overflow: shift-by-8 must not lose bits.
        if (len > (SIZE_MAX >> 8)) return false;
        len = (len << 8) | b;
    }
    *out_len = len;
    return true;
}
```

Three things are happening here that are not happening in most production code:

1. **Reject indefinite form unless you really mean to support it.** In DER it's forbidden; in BER it's allowed but a known parser-confusion source. Just say no.
2. **Reject length-of-length wider than `size_t`.** Otherwise an attacker can specify "9-byte length" and you read 9 bytes thinking it'll fit in 8.
3. **Overflow-check the shift accumulation.** The CWE-190 family of integer-overflow CVEs lives in exactly this pattern.

This little function is where you should expect to find bugs if you're auditing real C parsers. Many implementations are off by one of the three checks above.

---

## 8. Common pitfalls (the CVE pattern catalog)

1. **Trusting the length field.** "The packet says 200 bytes follow, so I'll `memcpy` 200." → Heartbleed. **Always** clip against remaining.

2. **Computing offsets with addition that can overflow.** `if (cursor + n > end)` on `size_t` near `SIZE_MAX` wraps. Use *subtraction*: `if (n > end - cursor)`.

3. **Forgetting the length-of-length is also attacker-controlled.** See ASN.1 above.

4. **Allowing zero-length values with type semantics that imply non-empty.** A length-zero hostname, length-zero certificate field, etc. Each can crash a consumer that assumed non-empty.

5. **Mixing signed and unsigned.** `int len = (int)tlv.length;` on a `uint16_t` is fine — but `int len = -1` from an underflow elsewhere `* sizeof(struct X)` becomes a giant positive number after promotion. Use `size_t` everywhere and don't let signed leak in.

6. **Forgetting that pointer-into-buffer aliases the input buffer.** `out->value = buf + i;` is correct, but the buffer must outlive every TLV that holds a pointer into it. Real parsers either *copy* values into owned memory or carefully tie lifetimes.

7. **Truncation in nested protocols.** TLS record says "300 bytes," handshake header inside says "350 bytes." Without bounded sub-cursors, the inner parser walks past the record into the next one. The sub-cursor pattern above structurally prevents this.

8. **Allowing recursion to consume the stack.** Nested TLV can be arbitrarily deep on an attacker's say-so. Cap recursion depth (16 or 32 is usually sane).

9. **State after error.** When a read fails, is the cursor in a defined state? Above, we say "no — caller must abort." That's the simplest defensible contract. Don't try to recover mid-TLV.

10. **Lying-pad games.** Some protocols pad to alignment. Padding is *always* attacker-controlled; never read past it without bounds-checking the alignment-padding length itself.

---

## 9. Variations & sibling protocols

- **TLV-with-tag-classes** (ASN.1): the type byte encodes class + constructed/primitive flag + tag number. Adds a bit-decoding step but the bounds story is identical.
- **Type-Tag-Length-Value (TTLV)**: KMIP. Two separate type/tag fields. Same discipline.
- **Length-Value (LV)**: simpler — type is implicit from position. DNS labels. Pascal strings.
- **CBOR / MessagePack**: typed values with self-describing length encoding (1, 2, 4, or 8 bytes depending on a 3-bit selector). Same family.
- **Protobuf**: varint-encoded field tag, varint length for length-delimited fields. The varint decoder is *itself* an attack surface (a 10-byte varint can encode a 64-bit value; a malformed long varint can drive integer overflow).
- **TLS records**: 5-byte header, body up to 2^14. Modern implementations (rustls, BoringSSL) use cursor-shaped parsers exactly like ours.
- **DER vs. BER**: DER is BER restricted to "one valid encoding per value." DER parsers are easier to make safe. Prefer DER when you can.

---

## 10. Where this shows up in the real world

- **TLS/QUIC**: every record, every handshake message, every extension is TLV-shaped. Cursor-based parsers are the modern hardening pattern (rustls, BoringSSL, picoquic).
- **Cryptography**: X.509, PKCS#7, CMS — all ASN.1 BER/DER, all TLV trees. Endless CVE history; the OpenSSL ASN.1 parser has been a perennial bug source.
- **Networking**: BGP UPDATE messages, DHCP options, ICMPv6 options, RADIUS, DIAMETER, OSPF LSAs.
- **Storage formats**: TIFF (IFD entries), PNG (chunks), Matroska/MKV (EBML, a TLV variant), WAV/RIFF (chunks).
- **Embedded / IoT**: USB descriptors, Bluetooth GATT, NDEF (NFC), Zigbee. The bug class repeats because the protocol shape repeats.
- **Smart cards**: APDU command/response TLVs (ISO 7816).
- **Banking**: ISO 8583 messages.
- **Hardware roots of trust**: TPM commands, attestation blobs. ASN.1 again.

---

## 11. Going deeper

1. **Write the adversarial test suite.** Fuzz it with `afl++` or `libFuzzer`. You'll be shocked the first time you find a bug.
2. **Build a varint reader** and decode a real Protobuf message by hand. Same discipline, different shape.
3. **Read the BoringSSL or rustls record-layer parser.** Notice how every read is cursor-style.
4. **Read the LangSec papers** (Sergey Bratus et al.). "The Seven Turrets of Babel" and "Curing the Vulnerable Parser" are foundational. The argument: parser-driven vulnerabilities are a *structural* feature of how we deploy languages around binary protocols, not just programmer error.
5. **Build a tiny ASN.1 BER parser** with this cursor as the substrate. You'll get a real feel for why ASN.1 is hated — and why DER (the canonical restriction) is the safer subset.
6. **Add a maximum-recursion-depth limit** to `tlv_parse_nested`. Test it.
7. **Try parsing Heartbleed's exact packet shape.** Walk through what would have happened with a cursor-based parser.

---

## 12. Industry context

- **Active debate**: "Generate parsers from a grammar (Hammer, Wuffs, Kaitai Struct)" vs. "hand-write cursor-based parsers." Generated parsers prevent the bounds-check class of bugs *by construction*; hand-written parsers are still common because of performance, integration, and legacy. The LangSec community argues we should not be hand-writing binary-protocol parsers in 2025. The systems community is partially convinced.
- **Historical context**: Cyclone (early 2000s), Hammer, Wuffs (Google, 2017), and Rust's `nom` and `winnow` all derive from the same observation — that binary parsing is a CWE-805 minefield in unmanaged languages. The cursor pattern in this doc is the manual approximation of what those tools provide automatically.
- **Heartbleed (2014)** is the canonical teaching example. It was a TLV (TLS heartbeat) parser that trusted the length field. The fix was a one-line bounds check. The damage was enormous — and the lesson, that this bug class is *structural*, has driven a generation of safer-parsing research.
- **What a tech lead would ask**: "How are you bounding nested-depth?" "Where do you allocate copies of values vs. holding pointers into the input?" "What's your fuzzing story?" "Are you handling varint overflow?" "Have you considered a generated parser?"
- **Forward-looking**: Rust adoption in TLS/parsers (rustls, quinn, hyper) and the rise of grammar-driven parser generators (Wuffs, in particular, is designed to be *boring* — it cannot allocate, cannot panic, cannot exceed declared bounds). Mainline browsers are migrating critical parsers to Rust. Industry direction is clear: by 2030, hand-written C binary parsers in security boundaries will be regarded the way hand-rolled crypto is regarded today.
- **Names worth knowing**: Sergey Bratus / Meredith Patterson (LangSec), Nick Mathewson (Tor, careful parser practice), Mike Hearn (early Bitcoin TLV-shaped formats), Nigel Tao (Wuffs).

---

## 13. Self-check questions

1. Why `remaining < n` instead of `pos + n > len`?
2. Why is `cur_sub` structurally safer than passing `(buf, offset, length)` to a nested parse function?
3. What's the bug in `int len = first_byte << 24 | ...`?
4. Why reject ASN.1 indefinite-length-form unless you're sure you need it?
5. What was the actual mistake in Heartbleed, expressed in cursor-pattern terms?
6. Why does `tlv_parse_one` return `false` on partial reads instead of trying to recover?
7. Name three real-world protocols that are TLV-shaped.
8. What does it mean that the parser "stores pointers into the input buffer" — and what's the lifetime contract that implies?

If you can rattle these off, this exercise has done its job.
