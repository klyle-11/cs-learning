// Saved media found in a file, and a page that shows it.
//
// Three kinds of file are understood:
//
//   JSON        an export of saved items. An item is an object with some of
//               "thumbnailUrl" (how it looked where it was found: a picture,
//               or a short clip), "sourcePage" (the page it was found on),
//               "mediaPage" (the page it leads to), "title", and "directMedia"
//               (the media itself; for some sites two addresses, one the
//               picture without sound and one the sound). The names these
//               had before are read as well: "mediaUrl", "postUrl", "linkUrl",
//               "directUrls", "ytDlpUrls". Upper and lower case are not told
//               apart. Each such object is one item, wherever in the file it is.
//   bookmarks   the HTML a browser writes when bookmarks are exported: every
//               <a href="…">name</a> is an item.
//   anything else, and JSON with no such objects
//               every "https://…" in the text, in order, each once.
//
// What an address points at is told from its ending (the kinds of file a
// browser shows or plays), or from what it says of itself ("format=jpg",
// "mime=video%2Fmp4"): a picture, a video, sound. Anything else is a page,
// under whichever name it was saved; only direct media becomes a card.
//
// The page made from the items (`cards`) is a gallery like the reader's own
// for a folder of pictures, with the addresses that are only pages in a table
// under it. It is sent with a policy of its own and shown in a frame apart
// from the reader, which itself never loads anything from another site.
#pragma once

#include <algorithm>
#include <cctype>
#include <initializer_list>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "../vendor/cJSON.h"
#include "anchor.hpp"

namespace links {

struct Link {
  std::string url;
  const char *kind;   // "image", "video", "audio" or "page"
};
struct Part {
  std::string url, kind, label;   // kind: "image", "video", "audio" or "page"; label: what it is to the item ("thumbnail", "linked page", ...)
};
struct Item {
  std::string title, thumb, page;   // a name, a picture to show for it, a page to open
  std::string preview;              // a short clip that stands for it as a moving thumbnail, when the media itself is listed apart
  std::vector<Link> media;          // what can be played
  std::vector<Part> all;            // every address the item groups together, each named for what it is: listed under its card
};

inline const char *kind_of(const std::string &url) {
  const size_t cut = url.find_first_of("?#");
  std::string path = url.substr(0, cut), rest = cut == std::string::npos ? "" : url.substr(cut);
  for (char &c : path) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
  for (char &c : rest) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
  while (!path.empty() && path.back() == '/') path.pop_back();   // "…/394826.mp4/": some hosts end a file's address with a slash
  const size_t dot = path.rfind('.'), slash = path.rfind('/');
  std::string ext = dot == std::string::npos || (slash != std::string::npos && dot < slash) ? "" : path.substr(dot);
  ext = ext.substr(0, ext.find(':'));   // "….jpg:large"
  auto among = [&](std::initializer_list<const char *> list) { for (const char *x : list) if (ext == x) return true; return false; };
  // The kinds of file a browser shows or plays by itself. Anything else is a page: only an address that is
  // the media itself (a direct address) becomes a card, and a page is never drawn as a picture or played.
  if (among({".jpg", ".jpeg", ".jfif", ".pjpeg", ".png", ".apng", ".gif", ".webp", ".avif", ".bmp", ".svg", ".ico"})) return "image";
  if (among({".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mkv"})) return "video";
  if (among({".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac", ".weba"})) return "audio";
  // Some hosts say the kind in the question instead: "…/media/abc?format=jpg", "…/photo?fm=webp", "…/videoplayback?…&mime=audio%2Fwebm".
  for (const char *key : {"format=", "fm="}) {
    for (size_t at = rest.find(key); at != std::string::npos; at = rest.find(key, at + 1)) {
      if (rest[at - 1] != '?' && rest[at - 1] != '&') continue;   // the whole name, not the end of another
      const size_t from = at + std::string(key).size();
      const std::string value = rest.substr(from, rest.find_first_of("&#", from) - from);
      for (const char *f : {"jpg", "jpeg", "png", "webp", "gif", "avif"}) if (value == f) return "image";
      for (const char *f : {"mp4", "webm"}) if (value == f) return "video";
    }
  }
  if (rest.find("mime=image") != std::string::npos) return "image";
  if (rest.find("mime=video") != std::string::npos) return "video";
  if (rest.find("mime=audio") != std::string::npos) return "audio";
  // A file's type anywhere in the address after the site, not only at its end: "…/clip.mp4/play", "…/get?file=clip.mp4&x=1".
  // It counts where the type's letters stop there (".mp4/", ".mp4?", not ".mp4x"). Video is looked for first.
  const size_t host_end = path.find('/', 8);
  const std::string after = (host_end == std::string::npos ? "" : path.substr(host_end)) + rest;
  auto holds = [&](std::initializer_list<const char *> list) {
    for (const char *x : list) {
      const size_t len = std::string(x).size();
      for (size_t at = after.find(x); at != std::string::npos; at = after.find(x, at + 1)) {
        const char next = at + len < after.size() ? after[at + len] : '/';
        if (!((next >= 'a' && next <= 'z') || (next >= '0' && next <= '9'))) return true;
      }
    }
    return false;
  };
  if (holds({".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mkv"})) return "video";
  if (holds({".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac", ".weba"})) return "audio";
  if (holds({".jpg", ".jpeg", ".jfif", ".png", ".apng", ".gif", ".webp", ".avif", ".bmp"})) return "image";
  return "page";
}
inline bool is_https(const std::string &url) { return url.compare(0, 8, "https://") == 0 && url.size() > 8 && url.size() <= 4000; }
// A .webm is taken for a short clip of the kind that used to be an animated picture: it may start by itself, and loops.
inline bool is_clip(const std::string &url) {
  std::string path = url.substr(0, url.find_first_of("?#"));
  while (!path.empty() && path.back() == '/') path.pop_back();
  return path.size() > 5 && (path.compare(path.size() - 5, 5, ".webm") == 0 || path.compare(path.size() - 5, 5, ".WEBM") == 0);
}

// One address as an item: a picture shows itself, media plays, a page is a link.
inline Item item_of(const std::string &url, const std::string &title = "") {
  Item it;
  it.title = title;
  const std::string kind = kind_of(url);
  if (kind == "image") it.thumb = it.page = url;
  else if (kind == "page") it.page = url;
  else it.media.push_back({url, kind_of(url)});
  return it;
}

// Every https address in a text, in order, each once.
inline void scan_text(const std::string &text, size_t most, std::vector<Item> &out, bool &more) {
  std::set<std::string> seen;
  for (size_t at = text.find("https:"); at != std::string::npos; at = text.find("https:", at + 1)) {
    // JSON writes "/" as "\/" if it likes, and "&" as "&".
    std::string url = "https://";
    size_t i = at + 6;
    int slashes = 0;
    while (i < text.size() && slashes < 2) {
      if (text[i] == '/') { slashes++; i++; }
      else if (text[i] == '\\' && i + 1 < text.size() && text[i + 1] == '/') { slashes++; i += 2; }
      else break;
    }
    if (slashes != 2) continue;
    for (; i < text.size() && url.size() < 4000; i++) {
      const unsigned char c = static_cast<unsigned char>(text[i]);
      if (c == '\\' && text.compare(i, 2, "\\/") == 0) { url += '/'; i++; continue; }
      if (c == '\\' && text.compare(i, 6, "\\u0026") == 0) { url += '&'; i += 5; continue; }
      if (c <= ' ' || c == '"' || c == '\'' || c == '<' || c == '>' || c == '\\' || c == '`' || c == '|' || c == '{' || c == '}' || c == '^' || c >= 0x7F) break;
      url += static_cast<char>(c);
    }
    // The full stop or bracket after an address in a sentence is not part of it.
    while (!url.empty() && std::string(".,;:!?)]").find(url.back()) != std::string::npos) url.pop_back();
    if (!is_https(url) || !seen.insert(url).second) continue;
    if (out.size() >= most) { more = true; return; }
    out.push_back(item_of(url));
  }
}

// The saved items in a JSON value, wherever they are in it.
inline void scan_json(const cJSON *node, int depth, size_t most, std::vector<Item> &out, bool &more) {
  if (!node || depth > 64 || more) return;
  if (cJSON_IsObject(node)) {
    // The first of the names that is there as text. (cJSON_GetObjectItem does not tell upper case from lower.)
    auto text = [&](std::initializer_list<const char *> keys) {
      for (const char *key : keys) { const cJSON *v = cJSON_GetObjectItem(node, key); if (cJSON_IsString(v) && v->valuestring && *v->valuestring) return std::string(v->valuestring); }
      return std::string();
    };
    Item it;
    it.title = text({"title"});
    const std::string media = text({"thumbnailUrl", "mediaUrl"}), link = text({"mediaPage", "linkUrl"}), post = text({"sourcePage", "postUrl"});
    it.page = is_https(link) ? link : is_https(post) ? post : "";
    // The media itself is what is listed under "directUrls"; "mediaUrl" is how
    // the thing looked where it was found. So: the direct addresses are what
    // plays. A "mediaUrl" that is a picture is the thumbnail; one that is a
    // clip (.webm) is a moving thumbnail if there is direct media, and
    // otherwise is itself the media. One that is a video file of another kind
    // (.mp4, ...) is no thumbnail whatever it was saved as: it is the video
    // itself, a direct address, and is named and played as one. An address
    // that is not a media file at all (see kind_of) is a page under whichever
    // name it was saved: it is listed and linked, never drawn or played.
    bool paged = false;   // a page was found among what was saved as media
    auto direct = [&](const cJSON *one) {
      if (!cJSON_IsString(one) || !one->valuestring || !is_https(one->valuestring)) return;
      for (const Link &had : it.media) if (had.url == one->valuestring) return;
      const std::string kind = kind_of(one->valuestring);
      if (kind == "image") { if (it.thumb.empty()) it.thumb = one->valuestring; }
      else if (kind == "page") { if (it.page.empty()) it.page = one->valuestring; paged = true; }
      else it.media.push_back({one->valuestring, kind == "audio" ? "audio" : "video"});
    };
    // Everything the object holds, for the list under its card: how it looked, what plays, and the pages it came from.
    auto part = [&](const std::string &url, const std::string &kind, const char *label) {
      if (!is_https(url)) return;
      for (const Part &had : it.all) if (had.url == url) return;
      it.all.push_back({url, kind, label});
    };
    if (is_https(media)) { const std::string k = kind_of(media); part(media, k, k == "page" ? "page" : k == "video" && !is_clip(media) ? "video" : k == "audio" ? "sound" : "thumbnail"); }
    auto listed = [&](const cJSON *one) {
      if (!cJSON_IsString(one) || !one->valuestring) return;
      const std::string k = kind_of(one->valuestring);
      part(one->valuestring, k, k == "image" ? "picture" : k == "audio" ? "sound" : k == "video" ? (is_clip(one->valuestring) ? "webm" : "video") : "page");
    };
    for (const char *key : {"directMedia", "directUrls", "ytDlpUrls"}) {
      const cJSON *list = cJSON_GetObjectItem(node, key), *one;
      if (cJSON_IsString(list)) listed(list);
      else cJSON_ArrayForEach(one, list) listed(one);
    }
    part(link, "page", "linked page");
    part(post, "page", "source page");
    for (const char *key : {"directMedia", "directUrls", "ytDlpUrls"}) {
      const cJSON *list = cJSON_GetObjectItem(node, key), *one;
      if (cJSON_IsString(list)) direct(list);   // one address, not a list of them
      else cJSON_ArrayForEach(one, list) direct(one);
    }
    if (is_https(media)) {
      const std::string kind = kind_of(media);
      if (kind == "image") it.thumb = media;
      else if (kind == "page") { if (it.page.empty()) it.page = media; }
      else if (it.media.empty()) it.media.push_back({media, kind_of(media)});
      else if (kind == "video" && is_clip(media)) it.preview = media;
      else if (kind == "video") { bool had = false; for (const Link &l : it.media) had = had || l.url == media; if (!had) it.media.push_back({media, "video"}); }
    }
    if (!it.thumb.empty() || !it.media.empty() || (!it.page.empty() && (!media.empty() || !it.title.empty() || paged))) {
      if (out.size() >= most) { more = true; return; }
      out.push_back(it);
      return;
    }
  }
  const cJSON *child;
  cJSON_ArrayForEach(child, node) scan_json(child, depth + 1, most, out, more);
}

// The bookmarks in a browser's export: each <a href="…">name</a>.
inline void scan_bookmarks(const std::string &html, size_t most, std::vector<Item> &out, bool &more) {
  std::set<std::string> seen;
  for (size_t at = 0; (at = html.find('<', at)) != std::string::npos; at++) {
    if (at + 2 >= html.size() || (html[at + 1] != 'a' && html[at + 1] != 'A') || !std::isspace(static_cast<unsigned char>(html[at + 2]))) continue;
    const size_t close = html.find('>', at);
    if (close == std::string::npos) return;
    std::string tag = html.substr(at, close - at), low = tag;
    for (char &c : low) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
    const size_t h = low.find("href=\"");
    const size_t e = h == std::string::npos ? std::string::npos : tag.find('"', h + 6);
    if (e == std::string::npos) continue;
    std::string url, name;
    for (size_t k = h + 6; k < e;) { if (tag[k] == '&') { const size_t took = anchor::entity(tag, k, url); if (took) { k += took; continue; } } url += tag[k++]; }
    const size_t end = html.find('<', close + 1);
    const std::string raw = html.substr(close + 1, end == std::string::npos ? std::string::npos : end - close - 1);
    for (size_t k = 0; k < raw.size();) { if (raw[k] == '&') { const size_t took = anchor::entity(raw, k, name); if (took) { k += took; continue; } } name += raw[k++]; }
    if (!is_https(url) || !seen.insert(url).second) continue;
    if (out.size() >= most) { more = true; return; }
    out.push_back(item_of(url, name));
  }
}

// The items of a file, by what kind of file it is. `more` is set if there were more than `most`.
inline std::vector<Item> find(const std::string &name, const std::string &text, size_t most, bool &more) {
  std::vector<Item> out;
  more = false;
  std::string low = name;
  for (char &c : low) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
  auto ends = [&](const char *tail) { const std::string t = tail; return low.size() >= t.size() && low.compare(low.size() - t.size(), t.size(), t) == 0; };
  if (ends(".json")) {
    cJSON *root = cJSON_Parse(text.c_str());
    scan_json(root, 0, most, out, more);
    cJSON_Delete(root);
  } else if (ends(".html") || ends(".htm")) {
    scan_bookmarks(text, most, out, more);
  }
  if (out.empty()) scan_text(text, most, out, more);
  return out;
}

inline std::string escaped(const std::string &s) {
  std::string out;
  for (char c : s) {
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}
inline std::string host_of(const std::string &url) {
  const size_t end = url.find('/', 8);
  return url.substr(8, end == std::string::npos ? std::string::npos : end - 8);
}

// How the reader wants the page to look: the colours of the pane it is shown
// in (six hex digits each), and how wide a card is.
struct Look {
  std::string paper = "fdfcf7", shade = "f4f1e8", ink = "1d1b16", muted = "6f6a5f", rule = "ddd8ca", accent = "8c2f1b";
  int card = 150;
  bool reversed = false;   // last first: the grid, the table of pages and the list all turned round
  size_t item = static_cast<size_t>(-1);   // the item, by its place in the file, the page opens at (one the reader's find came upon); none if past the end
};
// What to call a thing with no title: the end of its address, or its site.
inline std::string name_of(const std::string &url) {
  const size_t cut = url.find_first_of("?#");
  std::string path = url.substr(0, cut);
  while (path.size() > 8 && path.back() == '/') path.pop_back();   // "…/394826.mp4/" is called 394826.mp4
  const size_t slash = path.rfind('/');
  const std::string last = slash == std::string::npos || slash < 8 ? "" : path.substr(slash + 1);
  return last.empty() ? host_of(url) : last;
}
// A video's address with "#t=0.1" after it: asked for that way, a browser
// shows the frame at that moment before the video is played, not a black box.
inline std::string first_frame(const std::string &url) { return url.find('#') == std::string::npos ? url + "#t=0.1" : url; }

// The page's style. The names are the reader's own (thumbs, thumb, reel, step), and so are the measures.
static const char *const CARDS_STYLE = R"CSS(
*{box-sizing:border-box}
body{margin:0;padding:10px 16px 40px;background:var(--paper);color:var(--ink);font:14px/1.4 "Helvetica Neue",Helvetica,Arial,sans-serif}
body.listed{padding-right:252px}
a{color:var(--accent)}
button{font:inherit;color:inherit;background:none;border:1px solid var(--rule);padding:1px 8px;cursor:pointer}
button:disabled{opacity:.35;cursor:default}
button[aria-pressed="true"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
h5{margin:14px 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:400}
.tools{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:-10px -16px 0;padding:8px 16px;border-bottom:1px solid var(--rule);background:var(--paper);font-size:12px;color:var(--muted)}
.tools label{display:flex;align-items:center;gap:6px}
.tools input{width:150px;accent-color:var(--accent)}
.tools select,.tools input[type=search]{font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--rule);padding:1px 4px}
tr[hidden]{display:none}
.pager{display:flex;align-items:center;gap:6px}
.pager.foot{justify-content:center;margin-top:12px;font-size:12px;color:var(--muted)}
.thumbs{columns:var(--card,150px);column-gap:8px}
.card{margin:0 0 8px;break-inside:avoid}
.card[hidden]{display:none}
.card.flash .thumb{outline:3px solid var(--accent);outline-offset:-3px}
.thumb{display:block;border:1px solid var(--rule);background:var(--shade);aspect-ratio:1;overflow:hidden;position:relative}
.more{display:flex;flex-wrap:wrap;gap:3px;max-height:5.2em;overflow-y:auto;padding-top:3px;font-size:10px;line-height:1.5}
.more button,.more a{max-width:100%;padding:0 5px;border:1px solid var(--rule);color:var(--muted);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.more .on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.thumb a{display:block;height:100%;text-decoration:none}
.thumb a:focus-visible{outline:3px solid var(--accent);outline-offset:-3px}
.thumb img,.thumb video{width:100%;height:100%;object-fit:cover;display:block}
.play,.shut{position:absolute;padding:0;border-radius:50%;background:color-mix(in srgb,var(--paper) 82%,transparent);color:var(--ink)}
.play{top:50%;left:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;width:min(40px,44%);aspect-ratio:1}
.play svg{display:block;width:46%;height:auto}
.shut{top:4px;right:4px;width:24px;height:24px;font-size:16px;line-height:1}
.thumb .live{position:absolute;inset:0;object-fit:contain;background:#000}
.thumb.playing a,.thumb.playing .play{display:none}
.thumb b{position:absolute;left:0;right:0;bottom:0;padding:3px 5px;background:color-mix(in srgb,var(--paper) 88%,transparent);font-size:11px;font-weight:400;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thumb i{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 12px/1 inherit;color:var(--muted);font-style:normal}
.thumb u{position:absolute;top:4px;left:4px;padding:1px 5px;background:color-mix(in srgb,var(--paper) 88%,transparent);color:var(--ink);font-size:10px;text-decoration:none}
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
td,th{border:1px solid var(--rule);padding:5px 8px;text-align:left;vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{background:var(--shade);font-weight:600}th:nth-child(1){width:38%}th:nth-child(2){width:22%}
tr:target td{background:var(--shade)}tr:target{outline:3px solid var(--accent);outline-offset:-3px}
.list{display:none;position:fixed;top:0;right:0;bottom:0;width:236px;z-index:1;overflow-y:auto;padding:8px 8px 24px;border-left:1px solid var(--rule);background:color-mix(in srgb,var(--paper) 70%,transparent);font-size:11px}
body.listed .list{display:block}
.list:hover{background:color-mix(in srgb,var(--paper) 94%,transparent)}
.list h5{margin:8px 0 2px}
.list a{display:block;padding:1px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink);text-decoration:none;opacity:.5}
.list a.here,.list a:hover{opacity:1}.list a:hover{background:var(--shade)}
.list small{display:inline-block;width:3.4em;color:var(--muted)}
.view{display:none;position:fixed;inset:0;z-index:2;flex-direction:column;background:var(--paper)}.view:target{display:flex}
.bar{flex:none;display:flex;gap:10px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--rule);font-size:13px}
.bar span{flex:1 1 30%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.bar small{flex:none;color:var(--muted)}.bar a{flex:none;white-space:nowrap}
.bar a.url{flex:0 1 45%;min-width:0;overflow:hidden;text-overflow:ellipsis}
.addrs{flex:none;max-height:7.6em;overflow-y:auto;padding:4px 12px;border-bottom:1px solid var(--rule);font-size:12px;line-height:1.5}
.addrs div{display:flex;gap:8px}.addrs small{flex:none;width:7.5em;color:var(--muted)}.addrs a{min-width:0;overflow-wrap:anywhere}
.addrs .cur a{font-weight:600}.addrs .cur small::before{content:'\25B8 '}
.wrap{flex:1;min-height:0;display:flex;position:relative}
.stage{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;overflow:auto;background:var(--shade)}
.stage img,.stage video{display:block;flex:1 1 0;width:100%;min-height:0;object-fit:contain}
.stage img{cursor:zoom-in}.stage.full{display:block}.stage.full img{width:auto;margin:auto;cursor:zoom-out}
.stage video{background:#000}.stage audio{flex:none;width:min(90%,480px)}
.step{position:absolute;top:50%;transform:translateY(-50%);z-index:1;width:40px;height:60px;display:flex;align-items:center;justify-content:center;font-size:28px;line-height:1;text-decoration:none;border:1px solid var(--rule);background:color-mix(in srgb,var(--paper) 82%,transparent);color:var(--ink)}
.step.prev{left:8px}.step.next{right:8px}
.reel{flex:none;display:flex;gap:6px;justify-content:center;padding:6px 12px;border-top:1px solid var(--rule);overflow-x:auto}
.reel .thumb{flex:none;width:56px;margin:0;opacity:.75}.reel .thumb:hover,.reel .thumb.cur{opacity:1}.reel .thumb.cur{outline:3px solid var(--accent);outline-offset:-3px}
)CSS";

// The page's one script. What it does, in order:
//   - a video with no picture of its own is fetched only once it is in sight,
//     and then just far enough to show a frame; a clip in sight plays, silently
//   - a card takes the shape of its picture once that is known
//   - a card with a video gets a play button: pressing it plays the video in
//     the card, one at a time, with its sound in step if that is saved apart
//     (not a card whose thumbnail is a clip already playing: the button would only cover it)
//   - the grid is shown a page (60) at a time
//   - the size slider sets how wide a card is, and tells the reader, which remembers it
//   - the filters (a kind, an entry the item has, and words in the name or in any of its addresses) choose which cards the pages are made of
//   - "sort" puts the cards in order of their names, "shuffle" in a random order
//   - a card whose item groups several addresses lists them; pressing one shows it in the card,
//     (the viewer's bar has the address of what it shows, and under it every address of the item: written by the server)
//   - "reverse" tells the reader, which asks for the page again with the order turned round
//   - the list at the side marks what is on the page being shown; its links,
//     and "close" in the viewer, go to the page a card is on
//   - coming to a viewer: stop what was playing elsewhere, make its reel from
//     the cards on either side, start a clip
//   - a picture in the viewer is fitted to the window; pressing it shows it full size, and back
//   - left, right and Escape in the viewer
static const char *const CARDS_SCRIPT = R"JS(
const PER = 60, grid = document.getElementById('grid'), tiles = grid ? [...grid.children] : [];
// `tiles` stays in the file's order (a card's number is its place there).
// `order` is the order the grid is in now (sorted, shuffled, or as in the
// file); `shown` is what the filters let through of that, and makes the pages.
let order = tiles.slice(), shown = order, pages = Math.max(1, Math.ceil(tiles.length / PER));
const boxOf = (t) => t.querySelector('.thumb');   // the part of a card that shows the media
const list = document.getElementById('list'), size = document.getElementById('size');
let page = 0;
const load = (v) => { if (v && v.dataset.src && !v.src) v.src = v.dataset.src; };
const seen = new IntersectionObserver((all) => {
  for (const e of all) {
    const v = e.target;
    if (e.isIntersecting) { load(v); if ('peek' in v.dataset) v.play().catch(() => {}); } else v.pause();
  }
}, { rootMargin: '200px' });
const shape = (m) => { const w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight; if (w && h) m.closest('.thumb').style.aspectRatio = String(Math.min(2.5, Math.max(0.4, w / h))); };
for (const m of grid ? grid.querySelectorAll('img, video') : []) {
  m.addEventListener('load', () => shape(m));
  m.addEventListener('loadedmetadata', () => shape(m));
  if (m.complete) shape(m);
  if (m.tagName === 'VIDEO') seen.observe(m);
}
// Playing a video in its card. What to play is what the card's viewer would
// play, so the viewer's own players are asked: the address, whether it loops,
// and the sound when that is at an address of its own. The player is laid over
// the card's picture; there is one at a time, since each holds a connection open.
const stageOf = (t) => document.getElementById('v' + t.id.slice(1)).querySelector('.stage');
let live = null;
function shut() {
  const t = live;
  if (!t) return;
  live = null;
  for (const m of t.querySelectorAll('.live')) { if (m.pause) { m.pause(); m.removeAttribute('src'); m.load(); } m.remove(); }
  t.querySelector('.shut').remove();
  boxOf(t).classList.remove('playing');
  for (const c of t.querySelectorAll('.more .on')) c.classList.remove('on');
}
// With `one` (a button from the list under the card: one of the item's
// addresses) it is that address the card shows, a picture or something to
// play; without, the card's own video, with its sound.
function playHere(t, one) {
  shut();
  live = t;
  const box = boxOf(t), from = one ? null : stageOf(t).querySelector('video'), sound = one ? null : stageOf(t).querySelector('audio');
  const v = document.createElement(one && one.dataset.kind === 'image' ? 'img' : 'video'), x = document.createElement('button');
  v.className = 'live';
  if (v.tagName === 'IMG') { v.referrerPolicy = 'no-referrer'; v.alt = ''; }
  else { v.controls = v.playsInline = true; v.loop = from ? from.loop : /\.webm([?#]|$)/i.test(one.dataset.url); }
  v.src = one ? one.dataset.url : from.dataset.src || from.src;
  if (one) one.classList.add('on');
  x.className = 'shut';
  x.textContent = '×';
  x.title = 'Stop, and show the picture again';
  x.setAttribute('aria-label', x.title);
  box.classList.add('playing');
  box.append(v, x);
  if (v.tagName === 'IMG') return;
  v.play().catch(() => {});
  if (sound) {
    // A second player, unseen, follows the picture: it stops and starts with it and is put right when it drifts.
    const a = document.createElement('audio');
    a.className = 'live';
    a.src = sound.src;
    const step = () => { if (!a.seeking && Math.abs(a.currentTime - v.currentTime) > 0.3) a.currentTime = v.currentTime; };
    v.addEventListener('playing', () => { step(); a.play().catch(() => {}); });
    for (const ev of ['pause', 'waiting']) v.addEventListener(ev, () => a.pause());
    for (const ev of ['seeked', 'timeupdate']) v.addEventListener(ev, step);
    v.addEventListener('volumechange', () => { a.volume = v.volume; a.muted = v.muted; });
    v.addEventListener('ratechange', () => { a.playbackRate = v.playbackRate; });
    box.append(a);
    a.play().catch(() => {});   // asked for during the press itself: some browsers start sound only then
  }
  v.focus({ preventScroll: true });
}
for (const t of tiles) {
  if (!stageOf(t).querySelector('video') || boxOf(t).querySelector('video[data-peek]')) continue;
  const b = document.createElement('button');
  b.className = 'play';
  b.title = 'Play here';
  b.setAttribute('aria-label', 'Play here: ' + t.querySelector('a').title);
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
  boxOf(t).append(b);
}
function show(p) {
  page = Math.min(pages - 1, Math.max(0, p));
  for (const t of tiles) t.hidden = true;
  shown.slice(page * PER, (page + 1) * PER).forEach((t) => { t.hidden = false; });
  if (live && live.hidden) shut();
  for (const n of document.querySelectorAll('.pageno')) n.textContent = 'page ' + (page + 1) + ' of ' + pages;
  for (const b of document.querySelectorAll('.prev')) b.disabled = page === 0;
  for (const b of document.querySelectorAll('.next')) b.disabled = page === pages - 1;
  for (const a of list.querySelectorAll('a[data-i]')) a.classList.toggle('here', !tiles[a.dataset.i].hidden);
  for (const p of document.querySelectorAll('.pager')) p.hidden = pages < 2;
  list.querySelector('a.here')?.scrollIntoView({ block: 'nearest' });
}
// The filters: a kind (pictures, video, webm, sound), one of the entries an item of
// a JSON file can have (thumbnail, video, picture, sound, page, linked page, source
// page: the list offers those this file has) and words that must all be in the name or the addresses. They choose which cards the pages
// are made of; the table of pages under the grid is narrowed by the words too.
// A card's kind is its badge ("video", "webm" for a .webm clip, "sound"), or a picture if it has none;
// the entries it has are written on the card by the server ("data-has").
const kind = document.getElementById('kind'), saved = document.getElementById('saved'), find = document.getElementById('find'), count = document.getElementById('count');
const nameOf = (t) => t.querySelector('a').title.toLowerCase(), kindOf = (t) => t.querySelector('u')?.textContent || 'image';
const savedOk = (t) => !saved || !saved.value || t.dataset.has.split('|').includes(saved.value);
// What the words are looked for in: a card's name and every address it has (what its picture and its viewer
// show, and each address listed under it), so a card is found by a site or a file name in any one of them.
const hays = new Map();
function hayOf(t) {
  if (!hays.has(t)) {
    const view = document.getElementById('v' + t.id.slice(1));
    const urls = [...t.querySelectorAll('[data-url], [data-src], img[src], .more a'), ...view.querySelectorAll('.bar a.url, .addrs a, .stage [src], .stage [data-src]')].map((x) => x.dataset.url || x.dataset.src || x.getAttribute('src') || x.getAttribute('href') || '');
    hays.set(t, (nameOf(t) + ' ' + [...new Set(urls)].join(' ')).toLowerCase());
  }
  return hays.get(t);
}
function sift() {
  const words = find.value.toLowerCase().split(/\s+/).filter(Boolean), has = (text) => words.every((w) => text.includes(w));
  shown = order.filter((t) => (!kind.value || kindOf(t) === kind.value) && savedOk(t) && has(hayOf(t)));
  pages = Math.max(1, Math.ceil(shown.length / PER));
  for (const r of document.querySelectorAll('tbody tr')) r.hidden = !has(r.textContent.toLowerCase());
  count.textContent = shown.length === tiles.length ? '' : shown.length + ' of ' + tiles.length;
  show(0);
}
if (kind) { kind.addEventListener('change', sift); if (saved) saved.addEventListener('change', sift); find.addEventListener('input', sift); }
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'), img = e.target.closest('.stage img');
  if (img) img.parentNode.classList.toggle('full');
  if (!b) return;
  if (b.classList.contains('prev') || b.classList.contains('next')) { show(page + (b.classList.contains('next') ? 1 : -1)); scrollTo(0, 0); }
  if (b.id === 'listBtn') document.body.classList.toggle('listed');
  // The order is turned round by the server, so the page has to be asked for again. This page may not ask (to the
  // server it is a stranger); it tells the reader, which remembers the choice and loads the page anew.
  if (b.id === 'revBtn') parent.postMessage({ cardsReversed: b.getAttribute('aria-pressed') !== 'true' }, '*');
  if (b.classList.contains('play')) playHere(b.closest('.card'));
  if (b.classList.contains('shut')) { const t = b.closest('.card'); shut(); t.querySelector('.play')?.focus(); }
  if (b.dataset.url) { if (b.classList.contains('on')) shut(); else playHere(b.closest('.card'), b); }
  // Sorting and shuffling move the cards themselves, then the filters and pages are made again.
  if (b.id === 'sortBtn' || b.id === 'shuffleBtn') {
    const sort = document.getElementById('sortBtn'), on = b === sort && sort.getAttribute('aria-pressed') !== 'true';
    sort.setAttribute('aria-pressed', on);
    order = tiles.slice();
    if (on) order.sort((x, y) => nameOf(x).localeCompare(nameOf(y), undefined, { numeric: true }));
    if (b.id === 'shuffleBtn') for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    grid.append(...order);
    sift();
  }
});
if (size) {
  const set = () => document.body.style.setProperty('--card', size.value + 'px');
  size.addEventListener('input', () => { set(); parent.postMessage({ cardSize: Number(size.value) }, '*'); });
  set();
}
if (innerWidth >= 760 && list.children.length > 1) document.body.classList.add('listed');
function arrive() {
  for (const m of document.querySelectorAll('.view video, .view audio')) if (!m.closest('.view:target')) m.pause();
  const card =/^#g(\d+)$/.exec(location.hash), view = document.querySelector('.view:target');
  if (card && tiles[card[1]]) {
    const t = tiles[card[1]];
    if (!shown.includes(tiles[card[1]])) { kind.value = find.value = ''; if (saved) saved.value = ''; sift(); }   // filtered out: the filters are let go, so it can be shown
    show(Math.floor(shown.indexOf(tiles[card[1]]) / PER));
    t.scrollIntoView({ block: 'center' });
    t.classList.add('flash');
    setTimeout(() => t.classList.remove('flash'), 1200);
  }
  // A row of the table of pages is brought to the middle, clear of the bar at the top (the words filter is let go if it hid the row).
  const row = document.querySelector('tr:target');
  if (row) { if (row.hidden) { find.value = ''; sift(); } row.scrollIntoView({ block: 'center' }); }
  if (!view) return;
  shut();
  const i = Number(view.id.slice(1)), reel = view.querySelector('.reel');
  if (!reel.children.length) {
    for (let k = Math.max(0, i - 3); k <= Math.min(tiles.length - 1, i + 3); k++) {
      const c = boxOf(tiles[k]).cloneNode(true);
      c.style.aspectRatio = '';
      c.className = k === i ? 'thumb cur' : 'thumb';
      for (const x of c.querySelectorAll('b, u, button')) x.remove();
      reel.append(c);
    }
  }
  for (const r of reel.querySelectorAll('video')) { load(r); if ('peek' in r.dataset) r.play().catch(() => {}); }
  const v = view.querySelector('.stage video');
  load(v);
  if (v && 'auto' in v.dataset) v.play().catch(() => {});
  view.querySelector('.stage').classList.remove('full');
}
addEventListener('hashchange', arrive);
show(0);
// Sent for from the reader's find, the page opens at one item (the server names it on the body): its card, or
// its row. The grid shifts while its pictures take their shapes, so the card is brought back to the middle as
// they do, until the page is touched.
const sent = document.body.dataset.at;
if (sent && !location.hash) {
  location.replace('#' + sent);
  let held = true;
  for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => { held = false; }, { once: true, passive: true });
  const hold = () => { if (held && location.hash === '#' + sent) document.getElementById(sent).scrollIntoView({ block: 'center' }); };
  for (const m of document.querySelectorAll('#grid img, #grid video')) { m.addEventListener('load', hold); m.addEventListener('loadedmetadata', hold); }
}
arrive();
addEventListener('keydown', (e) => {
  const v = document.querySelector('.view:target');
  if (!v || e.target.matches('video, audio')) return;
  const to = v.querySelector(e.key === 'ArrowLeft' ? '.step.prev' : e.key === 'ArrowRight' ? '.step.next' : e.key === 'Escape' ? '.close' : 'x-none');
  if (to) { e.preventDefault(); to.click(); }
});
)JS";

// The page made from a file's items, laid out as the reader lays out a folder
// of pictures: a grid of cards for what can be seen or played, a page at a
// time, and, under it, a table of the addresses that are only pages. At the
// side, see-through, is a list of everything in the file: what there is, and
// a way to it. Pressing a card opens a viewer over the page, with an arrow to
// the one before and the one after and a reel of those nearby; the address is
// a link in the viewer's bar, and that is what opens in a new tab. A video can
// also be played where it is, by the play button on its card. The viewer's
// bar has the exact address of what it shows, as a link that opens it in a
// tab, and under the bar every address the item groups. The size slider
// and the page buttons stay at the top of the window while the grid scrolls.
// Every address and name is written out escaped; the one script is the
// server's own and carries the `nonce` the policy asks for.
inline std::string cards(const std::string &title, const std::vector<Item> &list, bool more, const std::string &nonce, const Look &look) {
  struct Seen { const Item *item; const Link *video, *audio; std::string name; };
  std::vector<Seen> media;
  std::vector<const Item *> pages;
  for (const Item &it : list) {
    const Link *video = nullptr, *audio = nullptr;
    for (const Link &l : it.media) {
      if (std::string(l.kind) == "audio") { if (!audio) audio = &l; }
      else if (!video) video = &l;
    }
    if (!video && !audio && it.thumb.empty()) { if (!it.page.empty()) pages.push_back(&it); continue; }
    media.push_back({&it, video, audio, !it.title.empty() ? it.title : name_of(video ? video->url : audio ? audio->url : it.thumb)});
  }
  auto lowered = [](std::string t) { for (char &c : t) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32); return t; };
  std::stable_sort(pages.begin(), pages.end(), [&](const Item *x, const Item *y) {
    const std::string hx = lowered(host_of(x->page)), hy = lowered(host_of(y->page));
    return hx != hy ? hx < hy : lowered(x->title) < lowered(y->title);
  });
  if (look.reversed) { std::reverse(media.begin(), media.end()); std::reverse(pages.begin(), pages.end()); }
  const size_t n = media.size();
  auto page_name = [](const Item *p) { return escaped(!p->title.empty() ? p->title : name_of(p->page)); };

  std::string html =
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
      "<meta name=\"referrer\" content=\"no-referrer\"><title>" + escaped(title) + "</title><style>"
      ":root{--paper:#" + look.paper + ";--shade:#" + look.shade + ";--ink:#" + look.ink + ";--muted:#" + look.muted + ";--rule:#" + look.rule + ";--accent:#" + look.accent + ";--card:" + std::to_string(look.card) + "px}" +
      CARDS_STYLE + "</style></head><body";
  // Where the page opens, when one item is asked for: that item's card, or its row in the table of pages. Only this, made here, goes into the page.
  std::string arrive;
  if (look.item < list.size()) {
    const Item *want = &list[look.item];
    for (size_t i = 0; i < n && arrive.empty(); i++) if (media[i].item == want) arrive = "g" + std::to_string(i);
    for (size_t j = 0; j < pages.size() && arrive.empty(); j++) if (pages[j] == want) arrive = "p" + std::to_string(j);
  }
  html += arrive.empty() ? std::string(">") : " data-at=\"" + arrive + "\">";

  if (n) {
    // The second filter lists the entries the items of this file have (a JSON file's; a list of plain addresses has none, and no such filter).
    std::string entries;
    for (const auto &[label, shown] : std::initializer_list<std::pair<const char *, const char *>>{{"thumbnail", "thumbnail"}, {"video", "video (full)"}, {"webm", "webm"}, {"picture", "picture (full)"}, {"sound", "sound"}, {"page", "page"}, {"linked page", "linked page"}, {"source page", "source page"}}) {
      bool any = false;
      for (const Seen &m : media) for (const Part &p : m.item->all) if (p.label == label) any = true;
      if (any) entries += std::string("<option value=\"") + label + "\">" + shown + "</option>";
    }
    if (!entries.empty()) entries = "<select id=\"saved\" aria-label=\"Show only the items that have this entry\"><option value=\"\">any entry</option>" + entries + "</select>";
    html += "<div class=\"tools\"><label>size <input id=\"size\" type=\"range\" min=\"70\" max=\"420\" value=\"" + std::to_string(look.card) + "\" aria-label=\"Size of the cards\"></label>"
            "<span class=\"pager\"><button class=\"prev\" aria-label=\"The page before\">‹</button><span class=\"pageno\"></span><button class=\"next\" aria-label=\"The next page\">›</button></span>"
            "<select id=\"kind\" aria-label=\"Show only one kind\"><option value=\"\">everything</option><option value=\"image\">pictures</option><option value=\"video\">video</option><option value=\"webm\">webm</option><option value=\"sound\">sound</option></select>" + entries +
            "<input id=\"find\" type=\"search\" placeholder=\"filter by name or address\" aria-label=\"Show only what has these words in its name or in one of its addresses\"><span id=\"count\"></span>"
            "<button id=\"listBtn\" title=\"Show or hide the list of everything in this file\">list</button>"
            "<button id=\"sortBtn\" aria-pressed=\"false\" title=\"Put the cards in order of their names. Press again for the order in the file.\">sort</button><button id=\"shuffleBtn\" title=\"Put the cards in a random order\">shuffle</button>"
            "<button id=\"revBtn\" aria-pressed=\"" + std::string(look.reversed ? "true" : "false") + "\" title=\"Turn the order round: the last in the file first\">reverse</button></div>"
            "<h5>Pictures, video and sound · " + std::to_string(n) + "</h5><div class=\"thumbs\" id=\"grid\">";
    for (size_t i = 0; i < n; i++) {
      const Seen &m = media[i];
      // The card is a box with a link in it, not a link: the script puts a play button, and the player, beside the link.
      // The entries it has, for the filter.
      std::string has;
      for (const Part &p : m.item->all) has += (has.empty() ? "" : "|") + p.label;
      html += "<div class=\"card\" id=\"g" + std::to_string(i) + "\" data-has=\"" + has + "\"><div class=\"thumb\"><a href=\"#v" + std::to_string(i) + "\" title=\"" + escaped(m.name) + "\">";
      // What stands for it: its picture; else its own moving thumbnail; else the video itself, showing its first frame (a clip plays).
      if (!m.item->thumb.empty()) html += "<img loading=\"lazy\" referrerpolicy=\"no-referrer\" alt=\"\" src=\"" + escaped(m.item->thumb) + "\">";
      else if (!m.item->preview.empty()) html += "<video muted loop playsinline preload=\"metadata\" data-peek data-src=\"" + escaped(m.item->preview) + "\"></video>";
      else if (m.video) html += "<video muted playsinline preload=\"metadata\"" + std::string(is_clip(m.video->url) ? " loop data-peek" : "") + " data-src=\"" + escaped(first_frame(m.video->url)) + "\"></video>";
      else html += "<i>sound</i>";
      if (m.video || m.audio) html += std::string("<u>") + (m.video ? (is_clip(m.video->url) ? "webm" : "video") : "sound") + "</u>";
      html += "<b>" + escaped(m.name) + "</b></a></div>";
      // An item that groups several addresses lists them under its picture. Pressing one shows it in the card; a page opens in a tab.
      if (m.item->all.size() > 1) {
        html += "<div class=\"more\">";
        for (const Part &p : m.item->all) {
          const std::string what = escaped(p.label + " · " + (p.kind == "page" ? host_of(p.url) : name_of(p.url)));
          if (p.kind == "page") html += "<a href=\"" + escaped(p.url) + "\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"" + escaped(p.url) + "\">" + what + "</a>";
          else html += "<button data-kind=\"" + p.kind + "\" data-url=\"" + escaped(p.url) + "\" title=\"Show this in the card: " + escaped(p.url) + "\">" + what + "</button>";
        }
        html += "</div>";
      }
      html += "</div>";
    }
    html += "</div><div class=\"pager foot\"><button class=\"prev\">‹ before</button><span class=\"pageno\"></span><button class=\"next\">next ›</button></div>";
  }
  if (!pages.empty()) {
    html += "<h5>Pages · " + std::to_string(pages.size()) + "</h5><table><thead><tr><th>Name</th><th>Site</th><th>Address</th></tr></thead><tbody>";
    for (size_t j = 0; j < pages.size(); j++) {
      const std::string url = escaped(pages[j]->page), name = page_name(pages[j]);
      html += "<tr id=\"p" + std::to_string(j) + "\"><td title=\"" + name + "\">" + name + "</td><td>" + escaped(host_of(pages[j]->page)) + "</td><td><a href=\"" + url + "\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"" + url + "\">" + escaped(pages[j]->page.substr(8)) + "</a></td></tr>";
    }
    html += "</tbody></table>";
  }
  if (list.empty()) html += "<p>No web addresses were found in this file.</p>";
  if (more) html += "<p>Only the first " + std::to_string(list.size()) + " are shown.</p>";

  // Everything in the file, as one line each.
  html += "<aside class=\"list\" id=\"list\" aria-label=\"Everything in this file\"><h5>" + std::to_string(list.size()) + (more ? "+" : "") + " in this file</h5>";
  for (size_t i = 0; i < n; i++) html += "<a href=\"#g" + std::to_string(i) + "\" data-i=\"" + std::to_string(i) + "\"><small>" + (media[i].video ? (is_clip(media[i].video->url) ? "webm" : "video") : media[i].audio ? "sound" : "image") + "</small>" + escaped(media[i].name) + "</a>";
  if (!pages.empty()) html += "<h5>Pages</h5>";
  for (size_t j = 0; j < pages.size(); j++) html += "<a href=\"#p" + std::to_string(j) + "\"><small>" + escaped(host_of(pages[j]->page)).substr(0, 40) + "</small> " + page_name(pages[j]) + "</a>";
  html += "</aside>";

  for (size_t i = 0; i < n; i++) {
    const Seen &m = media[i];
    const std::string at = std::to_string(i), thumb = escaped(m.item->thumb);
    // The address in the bar is that of what the stage shows, exactly: the video, else the picture, else the sound. (Not the page it came from: that is in the list under the bar.)
    const std::string &address = m.video ? m.video->url : !m.item->thumb.empty() ? m.item->thumb : m.audio ? m.audio->url : m.item->page;
    html += "<section class=\"view\" id=\"v" + at + "\"><div class=\"bar\"><span>" + escaped(m.name) + "</span><small>" + std::to_string(i + 1) + " of " + std::to_string(n) + "</small>"
            "<a class=\"url\" href=\"" + escaped(address) + "\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"Open in a new tab: " + escaped(address) + "\">" + escaped(address) + "</a>"
            "<a class=\"close\" href=\"#g" + at + "\">close</a></div>";
    // Under the bar, every address the item groups, in full, each a link; the one on show is marked.
    if (m.item->all.size() > 1) {
      html += "<div class=\"addrs\">";
      for (const Part &part : m.item->all)
        html += std::string("<div") + (part.url == address ? " class=\"cur\"" : "") + "><small>" + escaped(part.label) + "</small><a href=\"" + escaped(part.url) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + escaped(part.url) + "</a></div>";
      html += "</div>";
    }
    html += "<div class=\"wrap\"><div class=\"stage\">";
    if (m.video) html += "<video controls playsinline" + std::string(is_clip(m.video->url) ? " loop data-auto" : "") +
                         (thumb.empty() ? " preload=\"metadata\" data-src=\"" + escaped(first_frame(m.video->url)) + "\"" : " preload=\"none\" poster=\"" + thumb + "\" src=\"" + escaped(m.video->url) + "\"") + "></video>";
    else if (!thumb.empty()) html += "<img loading=\"lazy\" referrerpolicy=\"no-referrer\" alt=\"\" title=\"Press for full size\" src=\"" + thumb + "\">";
    if (m.audio) html += "<audio controls preload=\"none\" src=\"" + escaped(m.audio->url) + "\"></audio>";
    html += "</div>";
    if (i > 0) html += "<a class=\"step prev\" href=\"#v" + std::to_string(i - 1) + "\" title=\"Previous\">‹</a>";
    if (i + 1 < n) html += "<a class=\"step next\" href=\"#v" + std::to_string(i + 1) + "\" title=\"Next\">›</a>";
    html += "</div><div class=\"reel\"></div></section>";
  }
  html += "<script nonce=\"" + nonce + "\">" + std::string(CARDS_SCRIPT) + "</script></body></html>\n";
  return html;
}

} // namespace links
