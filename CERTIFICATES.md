# The hub's certificate authority

What happened on 3 October 2026, what to do on each device, how to check for trouble, and how to keep this manageable from here on. Written for the person who owns the hub and the devices; no background assumed.

Every fact in this file was re-checked against this Mac and the code on 3 October at 14:40. Where something is known only from reading, or was not tried, it says so.

## The short version

To reach the hub over HTTPS from a phone, each device installs a small file: the hub's own **certificate authority**. A device that trusts an authority accepts any certificate that authority signs.

- **The flaw.** The first authority the hub made could sign for *any* website, and the hub kept its private key on disk. Anyone who copied that key could have posed as any site to a device that trusted it.
- **The fix, done the same day.** The hub now makes an authority that can vouch only for the hub's own names and private-network addresses, and the key that could sign for anything is no longer stored anywhere.
- **What is left is on the devices.** The old authority must be removed from every device that installed it. Nothing on the server can do that for you.
- **Found while checking:** this Mac already trusts another home-made authority with the same weakness, from a developer tool called mkcert, since July 2025. See "Other authorities on this Mac".

Status at 14:40 on 3 October:

| Device | Old authority | New authority |
|---|---|---|
| This Mac | In the System keychain, set to deny for every use (checked). Not yet deleted. | **Not needed**: this Mac uses `http://localhost:4321`, which needs no authority (added 3 Oct, evening) |
| iPhone | **Presumed still installed and trusted: remove it** (I cannot see the phone) | Not installed |
| Windows laptop | Never had it | Not installed |
| The hub's server | The one running since this morning is **still presenting the old certificate** (checked) | Takes effect when it is restarted |

## Do these now

- [ ] **Mac:** stop the running server and start it again: `cd hub && HOST=0.0.0.0 npm start`. It will print the new fingerprint. On this Mac itself, use `http://localhost:4321` from now on: it needs no authority, so there is nothing to install here.
- [ ] **iPhone:** Settings → General → VPN & Device Management → "Hub local authority" → Remove Profile.
- [ ] **iPhone:** Settings → Wi-Fi → the (i) beside your network → Configure Proxy is "Off".
- [ ] **Each *other* device that should use the hub** (the iPhone, the Windows laptop): install the new authority (steps per system below), comparing the fingerprint first. On the iPhone this is the first real trial of the new certificates; if Safari still warns after the last step, stop and do not tap through the warning.
- [ ] **Mac:** delete "Hub local authority" from the System keychain when convenient. It is already harmless; everything worth knowing about it is recorded below.
- [ ] **iPhone:** in the same profile list, look for one named "mkcert kabdellah@Khalils-MacBook-Air.local" and remove it if present (see "Other authorities on this Mac").
- [ ] **Decide about mkcert on the Mac** (below).

## What happened, with times

Times are local to this Mac (UTC−4), with UTC in brackets.

| When | What | How this is known |
|---|---|---|
| 3 Oct, 04:31 (08:31) | First authority made. Name: **Hub local authority**. No limit on what it could sign; its key saved as `~/.config/hub/ca-key.pem`, readable by your account only. | The certificate's start date (the hub dates it one day back) |
| 04:41 (08:41) | iPhone paired with the hub. | The hub's list of devices |
| some time after 04:31 | The authority installed on the iPhone and this Mac. | You said so; the exact time is not recorded |
| during the day | A code review found the flaw (`REVIEW.md`, finding 17). | |
| 14:21 (18:21) | New authority made; the old key deleted. Name: **Hub authority (this hub only)**. | File times, and the certificate's start date |

The old key existed for 9 hours 50 minutes.

**The two authorities, for telling them apart on a device:**

| | Old (remove) | New (install) |
|---|---|---|
| Name | Hub local authority | Hub authority (this hub only) |
| Made | 3 Oct 2026, 04:31 | 3 Oct 2026, 14:21 |
| Ends | 30 Sep 2036 | 30 Sep 2036 |
| Limits on what it may sign | none | yes (listed below) |
| SHA-256 | `50:BA:19:8F:B2:B5:2A:1F:E0:62:3C:AD:2A:E4:ED:61:1B:DA:E5:4E:6C:62:56:B6:D3:9F:E2:9D:A0:20:76:B2` | `4B:0E:73:8A:C4:29:81:D2:12:62:17:B3:1B:9B:1E:75:95:87:17:6F:21:49:9B:A9:97:2D:A6:56:AE:A5:59:01` |
| SHA-1 (Windows calls this the "Thumbprint") | `0E:3F:FF:38:4E:2F:7B:86:10:F1:BD:FB:51:47:06:25:AF:1D:9C:BE` | `DA:C3:5B:DC:9F:0B:2D:5B:AC:A5:B9:19:7C:FD:7F:FA:0C:CA:B8:F3` |

Some systems show a fingerprint without the colons, in lower case, or in groups; the characters are what count. If the hub ever makes another authority (`--new-authority`, or a new state folder), these values change, and the server prints the new SHA-256 when it starts.

## Was anything compromised?

**What an attack would have needed,** inside those ten hours: a copy of the key file from this Mac, *and* a position on the same network as the iPhone or the Mac to intercept its traffic.

**What was checked on this Mac** (read-only):

| Question | Finding |
|---|---|
| Is the old key still on disk? | No. |
| Could a backup hold a copy? | No backup was found. Time Machine has no destination configured, and none of the common backup tools (Backblaze, Arq, CrashPlan, Carbon Copy Cloner and the like) is installed or running. |
| Is the state folder synced anywhere? | No. It is a real folder at `~/.config/hub`, not a link. There is no iCloud Drive folder. There is a `~/OneDrive` folder, but the state folder is not inside it, and OneDrive is not running (the app is no longer in Applications). |
| Is it kept in git (as some people keep their settings)? | No. Neither the state folder, `~/.config`, nor the home folder is a repository, and the key was never in this project. |
| Could the server have handed it out? | No. The state folder is never inside what is served, and requests that try to climb out of the served folder are refused (the server's test covers this). |
| Who is paired with the hub? | One device, "iPhone", paired 04:41. Nothing unknown. |
| Does the Mac still trust the old authority? | No. All ten of its trust entries are set to deny. |
| Did this session ever display the key? | No. Only file names, sizes and public certificates were printed. |

**What cannot be checked.**

- I know of no record, on macOS or iOS, of which certificates were accepted for which sites, so nothing would show a forged certificate having been used. I also could not read the Mac's system log from here (the query was refused). You can look yourself with the command below; I expect it to show nothing useful either way, because routine successful checks are not logged in detail.
  ```
  log show --last 12h --predicate 'process == "trustd"' --style compact | grep -i "hub"
  ```
- Nothing on the iPhone can be inspected from here.

So absence cannot be proven. What can be said:

- For the Mac itself, whoever could read that key already had access to your account. That would be a bigger problem, and not one this flaw caused.
- For the iPhone, it would take that same access to the Mac *plus* someone intercepting the phone on your network during those ten hours: a targeted attack, not an accident.

**Warning signs that would change this assessment:** a configuration profile or VPN on the iPhone that you did not install; a proxy set on your Wi-Fi network; an unknown device under "devices…" in the hub's settings; a certificate with custom trust on the Mac that you do not recognise (the next section lists the three that exist today).

**If you want certainty rather than likelihood:** change the passwords of accounts you signed into on the iPhone over Wi-Fi on 3 October and sign out their other sessions. The findings above do not call for it.

## Other authorities on this Mac

Three certificates on this Mac have had their trust changed by hand. One is the hub's old authority, covered above. The other two were found while checking:

**mkcert development CA** ("mkcert kabdellah@Khalils-MacBook-Air.local"). This is the same kind of thing as the hub's old authority, and it carries the same risk.

- Made 20 July 2025 by the developer tool `mkcert` (`/opt/homebrew/bin/mkcert`, version 1.4.4); ends 20 July 2035.
- In the System keychain, trusted as a root for web connections for the whole Mac.
- No limits on what it may sign.
- Its private key is on disk: `~/Library/Application Support/mkcert/rootCA-key.pem`, readable by your account only.
- mkcert's own documentation says of that file that it "gives complete power to intercept secure requests from your machine".

**Where it came from and where it has been used** (traced on 3 October from Homebrew's install record, file dates, certificates on disk, and the agents' own logs; times local):

| When | What happened | Who ran it |
|---|---|---|
| 20 Jul 2025, 06:34 | `brew install mkcert`, `mkcert -install`, then `mkcert localhost` in `~/dev/archive-spotify/client`. Spotify would only accept an `https` redirect address. | **GitHub Copilot Chat in agent mode** (a Claude Sonnet model), in the archive-spotify workspace. You confirmed each command. |
| 20 Jul 2025, 13:16 and 13:51 | `mkcert 127.0.0.1`; later `mkcert -install` again and `mkcert 127.0.0.1 localhost`. | The same chat, confirmed by you. |
| 29 Sep 2026, 08:03 to 08:11 | In the OSL project (`~/dev/osl-social-library-pwa-fastroute`), a script `scripts/cert.mjs` was written that calls mkcert and copies the *public* `rootCA.pem` into `certs/` for phones to download. A certificate was made at 08:11. | The script was written by **Claude Code** (the commit is co-authored by it). Its log does not show it running `npm run cert`, so that was probably you. |
| 29 Sep 2026, 08:16 | You reported the iPhone could not download `ca.pem`. The agent's answer was to AirDrop `rootCA.pem` to the iPhone and turn on full trust for "the mkcert root". | **Whether you did that is not recorded.** |
| 3 Oct 2026 | This session ran `mkcert -help`, `-version` and `-CAROOT`, and read the key file once to compute its fingerprint for the searches below. Its contents were never displayed. | Claude Code |

**What the searches found:**

- **The private key was never committed.** Its exact contents were looked for in the object store of all 78 git repositories on this Mac: not present in any.
- **No copy of the key** exists in `~/dev`, Documents, Desktop, Downloads or `~/OneDrive` (every file of the same size was compared).
- **No project refers to the key file.** The OSL script uses only the public certificate.
- **Certificates it issued, on disk:** six files in `~/dev/archive-spotify` (July 2025) and three in the OSL folder's `certs/` (September 2026). All are ignored by git; none was ever committed.
- **In git history:** only the OSL `fastroute` branch mentions mkcert (its README and the script), and that branch exists on this Mac only; it has not been pushed.
- **Other agents:** nothing about mkcert in the logs of Codex, opencode or Cursor's own agent. Claude Code's logs only go back to 25 September 2026, so July 2025 is known from the Copilot chat alone.

**What could not be checked:** repositories that exist only on GitHub and not on this Mac (the GitHub command-line tool is not installed here; GitHub's own code search for `mkcert` and `PRIVATE KEY` across your account would cover it). The file's "last read" time (11 June 2026) is not a reliable sign of use: macOS does not update it on every read, and the September certificate was made after it.

**The one thing to check by hand: the iPhone.** Settings → General → VPN & Device Management. If a profile named "mkcert kabdellah@Khalils-MacBook-Air.local" is there, the phone trusts an unlimited authority whose key has sat on this Mac since July 2025. Remove it.

**What to do about it on the Mac.** If you no longer need it for local development: `mkcert -uninstall` takes it out of the trust stores, and deleting the folder above removes the key. The archive-spotify and OSL certificates stop being trusted when you do, which only matters if you still run those projects over HTTPS. If you do still use it, keeping it is the trade its users accept; it is a decision rather than an oversight once you know it is there.

**nac.temple.edu.** Trusted for Wi-Fi login only (the "EAP" use), not for websites. This is what joining a campus network usually leaves behind, and it cannot be used to pose as a site.

## What the new authority can and cannot do

Certificates are now a chain of three, all in the state folder (`~/.config/hub`):

| File | What it is | Secret? |
|---|---|---|
| `ca.pem` | The authority a device installs. Its private key was used once, to sign the issuer, and was never written to disk. | No. Public. |
| `issuer.pem`, `issuer-key.pem` | The only thing the authority ever signed. It signs the server's certificates. | **`issuer-key.pem` is secret.** |
| `cert.pem`, `key.pem` | What the server presents. Re-made when the server starts, if the Mac's addresses have changed or fewer than 30 days remain (it currently ends 31 Dec 2028). | `key.pem` is secret. |

Both the authority and the issuer carry *name constraints*, marked critical, so software must either enforce them or refuse the certificate. They may vouch only for:

- names ending in `.local`, and `localhost`
- this Mac's own host name as it was when the authority was made: `khalils-air.fios-router.home` (`issuer.zones` holds the list)
- addresses in the ranges reserved for private networks: 127.x, 10.x, 172.16 to 172.31, 192.168.x, 169.254.x, and 100.64 to 100.127

The server's certificate currently covers `localhost`, `khalils-macbook-air.local`, `khalils-air.fios-router.home`, `hub.local`, `192.168.1.152` and `127.0.0.1`.

**What was tested, on this Mac, with your real certificates as deployed:**

| Test | LibreSSL | Apple's checker |
|---|---|---|
| The server's certificate, under the new authority | accepted | accepted, as `localhost`, `khalils-macbook-air.local`, `hub.local` and `192.168.1.152`; refused as `example.com` |
| A certificate for `example.com`, forged with the kept key | refused | refused |
| A certificate for a public address, forged with the kept key | refused | refused |
| A certificate forged through a further authority (on a test copy) | refused | refused |
| Control: the same forgery under an authority with no limits (test copy) | not run | **accepted**, which is what the old authority allowed |

The forged files were deleted afterwards. On a test copy made by the same code, the server was also started with the new chain and answered over HTTPS to a client trusting only the new authority.

**Not tested:** the iPhone, Windows, Android, Firefox. Two things carry over without relying on them. First, the only signing key that exists is the issuer's, and a limit on an issuer is the ordinary, long-supported case. Second, the limit is marked critical, so a program that did not understand it would have to refuse the hub's certificate outright, which fails safe: the worst outcome on such a device is that the hub does not open.

**Worst case now.** Someone who copies `issuer-key.pem` and is on the same network as one of your devices can pose as the hub, or as another device at a `.local` name or a private address on that network (a router's settings page, a printer). That is true on any network that uses private addresses, which includes most public Wi-Fi. They cannot pose as a website.

## Do you want this at all?

The authority exists for one reason: browsers only allow certain features on a connection they consider secure. If the phone does not need those, nothing has to be installed on any device.

| Option | Installed on devices | What works | What you give up | What you take on |
|---|---|---|---|---|
| **1. This computer only** (plain `npm start`) | Nothing | Everything, on the laptop itself: a browser treats `localhost` as secure | The phone cannot connect at all | Nothing |
| **2. Network without HTTPS** (`HUB_INSECURE_HTTP=1 HOST=0.0.0.0 npm start`) | Nothing | Reading, notes and highlights from the phone while it is on the same Wi-Fi; copies kept while the page stays open | Opening the reader with the server off, the home-screen app, encrypting the copies on the phone, folder locks. And anyone on that Wi-Fi can read and change what is sent, including the pairing token | Exposure on the network instead of on the device. Reasonable only on a network you fully control. *From reading the code; this mode was not tried.* |
| **3. The hub's own authority, limited** (what is built now) | One small authority per device, except the hub's own computer, which uses `http://localhost` and needs none | Everything | Nothing | The upkeep in this document. Worst case as described above |
| **4. A publicly trusted certificate** | No authority. Either the Tailscale app on each device, or a domain name you own | Everything | Some independence: it relies on an outside service, and the hub's name appears in public certificate logs | *Not built or tested.* Would need work in the server and some setup |

My reading: with the fix, option 3's risk is small and bounded, and it is the only one that works today with every feature. If you would rather have *no* authority of your own on devices you also use for work, option 4 is the way to keep full function; option 1 or 2 is the way to keep it simple.

**About a switch in the interface.** Two different things could be switched, and it helps to keep them apart:

- *The server side can be switched off:* stop listening on the network, and delete the certificates from the state folder. Today that is done by starting without `HOST=0.0.0.0`; it could be a control in the reader's settings on the hub's own machine.
- *The device side cannot be switched from the hub.* Once a device trusts an authority, only that device can remove it, by hand, in its own settings. A switch could show the steps for the device in front of you, and nothing more.

Neither is built. If you want one, the useful version is probably: "Network access: off / on" plus "Retire this hub's authority", which deletes the certificates, makes a fresh authority on next use, and lists the removal steps per device.

## Each system: check, remove, install

Menu names vary a little between versions. What was actually done or run in this session: the Mac's Terminal commands, and the removal you did on the Mac. **The install steps for the new authority have not been carried out on any device yet. The Windows, Android and Linux steps are the standard procedures and were not tried here.**

Always compare the fingerprint before installing. The server prints the SHA-256 when it starts, and the hub's `/trust` page shows what the device received; they must match the table above.

### iPhone and iPad

**See what is installed:** Settings → General → VPN & Device Management. Anything under "Configuration Profile" was added by hand. Settings → General → About → Certificate Trust Settings lists the authorities given full trust.

**Remove:** Settings → General → VPN & Device Management → the profile → Remove Profile.

**Install the new one:**
1. In Safari open `http://<the hub's address>:4321/` and follow the page to download `hub-ca.crt`; allow the profile.
2. Settings → General → VPN & Device Management → "Hub authority (this hub only)" → Install.
3. Settings → General → About → Certificate Trust Settings → switch on "Hub authority (this hub only)".
4. Open the reader over `https://`. No warning means it worked. A warning means stop: do not continue past it.

### Mac

**See what is installed** (these were run here; the first prints the SHA-256 without colons):

```
security find-certificate -a -c "Hub" -Z /Library/Keychains/System.keychain ~/Library/Keychains/login.keychain-db | grep -E "SHA-256|labl"
security dump-trust-settings -d     # certificates with trust changed for the whole Mac
security dump-trust-settings        # and for your user
```

A certificate in the System or login keychain set to "Always Trust" is accepted for websites just as a built-in one is. "System Roots" is Apple's own list; nothing can be added to it.

**Remove:** Keychain Access → System → Certificates → select it → delete (it asks for your password). "Never Trust" has the same effect while it stays.

**Install the new one** (only for a Mac that is *not* the one running the hub; on the hub's own Mac, open `http://localhost:4321` and install nothing):
1. In Keychain Access choose File → Import Items, press Cmd+Shift+G, enter `~/.config/hub/ca.pem`, and import it into the login keychain. (On a different Mac, download `hub-ca.crt` from the hub's `/trust` page and open it instead.)
2. Double-click "Hub authority (this hub only)" → Trust → set "Secure Sockets Layer (SSL)" to Always Trust. That one setting is enough and is narrower than the switch at the top.

The same from Terminal, if you prefer (not run here; it asks for your password):

```
security add-trusted-cert -r trustRoot -p ssl -p basic -k ~/Library/Keychains/login.keychain-db ~/.config/hub/ca.pem
```

**Confirm it is the limited one:**

```
security find-certificate -c "Hub authority" -p | openssl x509 -noout -text | grep -A10 "Name Constraints"
```

**Firefox** keeps its own list on every system: Settings → Privacy & Security → Certificates → View Certificates → Authorities (Import to add; select and Delete or Distrust to remove).

### Windows 10 and 11

**See what is installed:** press Win+R, run `certmgr.msc`, open Trusted Root Certification Authorities → Certificates. That is your user's list. Or in PowerShell:

```
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like "*Hub*" | Format-List Subject, NotBefore, NotAfter, Thumbprint
```

**Remove:** in `certmgr.msc`, right-click the certificate → Delete.

**Install the new one:**
1. Download `hub-ca.crt` from the hub's `/trust` page and open it.
2. Install Certificate → **Current User** → "Place all certificates in the following store" → Trusted Root Certification Authorities → Finish.
3. Windows shows a warning with a **Thumbprint**: that is the SHA-1 value in the table above, usually written without the colons. Compare it before pressing Yes.
4. Open the reader over `https://` in Edge or Chrome. No warning means it worked. If it warns, stop and note the exact message: it would mean Windows treats the limit differently from what was tested here.

Edge and Chrome use this list. Firefox uses its own (above).

**Antivirus.** Windows includes Microsoft Defender, which is on unless something turned it off. Open Windows Security → Virus & threat protection and confirm real-time protection is on, and keep Windows Update current. That is enough for this purpose.

### Android

**See what is installed:** Settings → Security (or "Security & privacy") → More security settings → Encryption & credentials → Trusted credentials → the **User** tab. Everything there was added by hand.

**Remove:** tap it → Remove. (Or "Clear credentials" for all of them.)

**Install the new one:** Encryption & credentials → Install a certificate → CA certificate → "Install anyway" → choose `hub-ca.crt` from Downloads.

Android then typically shows a standing notice that the network "may be monitored". That is its warning for any authority added by hand, and it is a fair description of what an unlimited one could do; with this one the limit applies.

### Linux

**Chrome:** Settings → Privacy and security → Security → Manage certificates → Authorities. **Firefox:** as above.

## Checklists from here on

**Before installing any authority on a device (this hub's or anyone's)**
- [ ] I know which machine made it and I am looking at that machine's own printout of the fingerprint.
- [ ] The fingerprint on the device matches, all of it.
- [ ] I am on a network I trust while doing this: the file travels unencrypted (`REVIEW.md`, finding 23).
- [ ] I know whether it has limits. One without limits can vouch for any site.
- [ ] It is recorded in the table below.

**Adding a device to the hub**
- [ ] Install the authority (above). Pair with a code from "devices…".
- [ ] Add the device to the table below.

**Every few months, and after anything odd**
- [ ] Each device: list the authorities added by hand (commands and menus above). Only expected ones are there.
- [ ] Hub → settings → "devices…": only devices you recognise. Remove the rest.
- [ ] `ls -l ~/.config/hub`: `issuer-key.pem`, `key.pem` and `devices.json` are readable by you only (`-rw-------`). They were on 3 October.
- [ ] The state folder is not inside a synced or shared folder, and you know which backups include it.

**If the Mac is lost, sold, repaired by someone else, or you suspect it**
- [ ] Remove the hub's authority from every device (it cannot be done from the hub).
- [ ] On the new or cleaned machine: `server-cpp/hubd --new-authority`, then install the new one on each device.
- [ ] Remove every paired device and pair again.

**Retiring the hub, or going back to "this computer only"**
- [ ] Remove the authority from every device.
- [ ] Delete `ca.pem`, `issuer.pem`, `issuer-key.pem`, `issuer.zones`, `cert.pem`, `key.pem` and `cert.names` from the state folder.

**Before the end of September 2036**
- [ ] The issuer ends on 29 September 2036 and the authority a day later. Make a new authority before then and install it on each device.

### Where authorities of your own are installed

Keep this up to date; it is the list to work through when something changes.

| Device | Authority | Installed | Removed |
|---|---|---|---|
| Mac (this one) | Hub local authority (old, no limits) | 3 Oct 2026 | set to deny 3 Oct; not yet deleted |
| iPhone | Hub local authority (old, no limits) | 3 Oct 2026 | **to do** |
| Mac (this one) | mkcert development CA (no limits) | 20 Jul 2025 | decide |
| iPhone | mkcert development CA (no limits) | possibly 29 Sep 2026: check | |
| Mac (this one) | Hub authority (this hub only) | | |
| iPhone | Hub authority (this hub only) | | |
| Windows laptop | Hub authority (this hub only) | | |

## Server commands

```
cd hub && HOST=0.0.0.0 npm start   # start on the network; prints the fingerprint (and a pairing code, if no device is paired yet)
server-cpp/hubd --make-cert        # make or renew certificates, print the fingerprint, stop
server-cpp/hubd --new-authority    # replace the authority; every device then installs the new one
openssl x509 -in ~/.config/hub/ca.pem -noout -subject -enddate -fingerprint -sha256
openssl x509 -in ~/.config/hub/ca.pem -noout -text | grep -A10 "Name Constraints"
```

A name of your own (not `.local`) has to be known when the authority is made: `server-cpp/hubd --new-authority --allow-host hub.example.org`. A name or address the issuer may not vouch for is left out of the server's certificate and reported at start-up.

## Resources

Each link was opened on 3 October 2026 and is the page its title says.

- Apple: [Trust manually installed certificate profiles in iOS, iPadOS, and visionOS](https://support.apple.com/en-us/102390)
- Apple: [Install or remove configuration profiles on iPhone](https://support.apple.com/guide/iphone/install-or-remove-configuration-profiles-iph6c493b19/ios)
- Apple: [Change the trust settings of a certificate in Keychain Access on Mac](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac)
- Microsoft: [How to view certificates with the MMC snap-in](https://learn.microsoft.com/en-us/dotnet/framework/wcf/feature-details/how-to-view-certificates-with-the-mmc-snap-in)
- Microsoft: [Stay protected with the Windows Security app](https://support.microsoft.com/en-us/windows/stay-protected-with-the-windows-security-app-2ae0363d-0ada-c064-8b56-6a39afb6a963)
- Google: [Add & remove certificates (Pixel)](https://support.google.com/pixelphone/answer/2844832)
- mkcert: [its documentation](https://github.com/FiloSottile/mkcert), including the warning about `rootCA-key.pem` quoted above
- The standard that defines name constraints: [RFC 5280, section 4.2.1.10](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.10)
- For option 4: [Tailscale, Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https) and [Let's Encrypt, Challenge Types](https://letsencrypt.org/docs/challenge-types/) (the DNS challenge is the one that suits a server only reachable at home)

In this repository: `REVIEW.md` (findings 17 and 23), `server-cpp/API.md` ("Security", point 2), `server-cpp/src/secure.hpp` (how the certificates are made), and the hub's own `/trust` page.
