# Certificate security audit — 11 October 2026

Persistence follow-up: C05 auto-formatting is now disabled in source. Failed state mounting logs `hub-state` and stops without erasing. Explicit offline `PrepareState` generates an empty image for blank new hardware; normal firmware flash never includes it. Full `erase-flash` still physically deletes stored identity. RESET/BOOT pairing hold and Wi-Fi retries preserve it. The former first-start wording was displayed on every boot, so it was not evidence of CA rotation. BOOT hold detection now uses elapsed time in the screen task rather than delayed watch samples. These changes compile but still need hardware validation.

This audit does not certify the system as mistake-free. It separates the live board's public certificate, disposable attack tests, source/configuration evidence, and changes that are not deployed. No root was installed in a trust store, no device trust settings were changed, no live private key was read, and no real certificate state was replaced.

## Live evidence

The owner identified `192.168.1.171:443`. An OpenSSL handshake received an ECDSA P-256 leaf and constrained issuer, negotiating TLS 1.2 with ECDHE-ECDSA-AES256-GCM-SHA384. The leaf has serverAuth EKU and SAN `192.168.1.171`; its chain and IP check succeed against the public CA downloaded from `/hub-ca.crt`. The issuer has critical name constraints and path length zero, but no extended-key-usage restriction. The downloaded root also has no EKU.

Root SHA-256 fingerprint:

`29:F2:11:FE:D4:C9:98:4F:DC:37:EF:74:D2:DB:8F:00:4C:58:C9:96:4E:90:C9:4E:62:EC:3A:2D:BC:D5:B4:55`

This is a network observation, not independent authentication of the board. Compare it with the full trusted USB serial output before installing trust. Public evidence is under `server-cpp/build/cert-audit-live/` and is ignored by git. Later TLS attempts timed out or received handshake failure; successful certificate validation is not proof of reliable server operation. The owner also reports cached readers opening while saying “server not reachable.”

## Findings, ordered by risk

| Finding | Prerequisite and effect | Status |
|---|---|---|
| C01 — Initial download was not bound to the fingerprint being checked | A network attacker on the initial untrusted connection can leave the displayed fingerprint correct while substituting a different downloaded root. Installing that root gives the attacker whatever authority their certificate contains, potentially unrestricted. | Instructions corrected to verify the actual file with a trusted tool/full serial fingerprint or use a trusted transfer. A web page delivered over HTTP cannot enforce its own integrity. |
| C02 — Existing issuer can sign for purposes beyond TLS | Theft of `issuer-key.pem` enables certificates outside DNS/IP name forms. A disposable legacy chain accepted an unrelated S/MIME certificate in OpenSSL and a code-signing certificate under Windows application-policy validation. The live root/issuer have the same lack of EKU. This does not show actual theft or compromise. | New root/issuer certificates receive critical serverAuth EKU. New tests reject email, client authentication and Windows code signing. Existing installed chains remain unchanged; flashing does not retrofit EKU. Deliberate replacement of the CA and removal of the old root on every device is needed. |
| C03 — “This hub only” overstated the TLS scope | Theft of the issuer key permits impersonation of other `.local` hosts and any permitted private IP address, including routers and services on other private networks. Roots/issuers also permit configured DNS zones and their descendants. | Demonstrated in scratch tests. Trust text corrected; scope has not been narrowed or rotated. IP churn and hostname requirements need an explicit replacement design. |
| C04 — Physical protection of signing keys is unproven | The state partition holds issuer and leaf private keys. Current sdkconfig disables flash encryption and secure boot; physical flash access or replacement firmware can expose them unless the actual device has separately provisioned protection. | Configuration verified; actual eFuse state not inspected. No eFuse/security setting changed. Protecting the board physically matters while a broad local CA is trusted. |
| C05 — Mount failure can erase certificate identity | `mount_state()` permits formatting on mount failure, beyond first boot. A damaged filesystem or transient mount failure can erase keys, pairing state and identity; an empty state then creates a new CA. Users may be prompted to install trust again without understanding the change. | Open. Requires explicit first-boot provisioning/recovery design. Not a reason to automatically accept a changed root. |
| C06 — Partial certificate state silently replaced the authority | Losing one issuer file previously caused new keys/root generation, leaving installed trust behind and making identity changes look routine. | Fixed in source: partial existing authority state fails closed with an explicit restore/`--new-authority` message. Empty first setup remains allowed. A regression proves the old CA bytes are preserved. Legacy automatic CA migration now also requires a deliberate replacement. |
| C07 — Long authority lifetime and no revocation channel | Root/issuer last roughly ten years. Compromise continues to matter on every device that retains the old root, regardless of what the server subsequently rotates. | Open design risk. Changing the server or reissuing the leaf cannot revoke an installed root. Old roots must be removed from all device/browser trust stores. |
| C08 — Entropy/write failures were not fully checked | Certificate serial generation ignored RNG failure; private/certificate file writes did not explicitly check flush/close errors before replacement. A failure can disclose uninitialised serial bytes or publish incomplete state. | Fixed: entropy failure aborts issuance; flush and close are checked. This does not make multi-file FAT saves transactional or finish B01 recovery. |

## What the attack tests establish

`test/certificates.mjs` makes a disposable chain with the actual hub generator. It rejects public DNS, public IPv4/IPv6, mixed allowed/disallowed SANs, DNS suffix tricks, wrong hostname, and a further ordinary subordinate CA. It deliberately confirms unrelated `.local` and private-IP certificates are accepted. New restricted chains reject S/MIME and client authentication in OpenSSL; Windows rejects a code-signing leaf for `NotValidForUsage` using an in-memory CustomRootTrust chain and ApplicationPolicy. No OS root store is changed.

The legacy email/code-signing proofs used a disposable pre-fix chain, not the board's issuer key. Windows desktop/OpenSSL results do not prove identical behavior in iOS, Android, Safari or Firefox. Name constraints on the intermediate remain important because trust-anchor handling differs across implementations. The mbedTLS name-constraint parse callback is for loading/presenting the hub's own chain, not a general remote-certificate verifier; outbound OTA HTTPS uses ESP-IDF's public CA bundle and verifies signed firmware separately.

## Deployment implications

The trust-page correction and firmware checks must be deployed. Existing certificate EKU will remain absent after a firmware flash because valid existing state is retained. Replacement must be explicit, preserve pairing/data separately, verify the new public CA through an independent trusted channel, and remove the old authority from every device that trusted it. Adding a second root while retaining the old one does not remove the old risk. A public DNS certificate or a leaf-only trust design would avoid keeping a general local issuing authority on an always-on board, but needs a separate implementation and device compatibility assessment.

No broad CA should be described as “only this board” on a device used for unrelated personal/work activities. No silent trust replacement or hardware security fuse provisioning is performed by this audit.

## Pairing and connection observations

Current firmware offers a startup code only when `devices.json` contains no paired devices. Resetting a board with saved devices does not generate a code. Visiting the reader cannot safely expose a code to an unpaired visitor. The old reader's claim that a code “is offering” was misleading and is corrected. Updated S3 source adds a physical six-second BOOT hold to request one code until release, using the existing watch task; it does not add an unauthenticated network endpoint. Hardware button verification remains pending. A missing code and “server not reachable” are separate symptoms: cached shell loading can coexist with failing TLS/API connections.

## References

Validation of the final source: 260 Windows contract requests pass, the expanded certificate attack/purpose/partial-state tests pass, and ESP-IDF 5.4.4 S3 firmware builds (image 0x162ea0 bytes, 21% of the app slot free). The trust-page/pairing changes and new firmware are not deployed; button behavior, device certificate migration and physical protection remain unverified.

- [RFC 5280, certificate constraints and path validation](https://www.rfc-editor.org/rfc/rfc5280.html).
- [Microsoft ApplicationPolicy](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509chainpolicy.applicationpolicy).
- [Espressif flash encryption](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/security/flash-encryption.html); enabling it has provisioning and recovery implications.
- [Apple manual-root trust](https://support.apple.com/en-ca/102390).
