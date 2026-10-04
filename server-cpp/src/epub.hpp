// An EPUB: a zip of XHTML pages with a few small XML files saying what is what.
//
//   META-INF/container.xml   names the package file
//   the package file (.opf)  the book's title; the "manifest", every file in
//                            the book with an id; the "spine", the ids of the
//                            pages in reading order
//   toc.ncx (EPUB 2) or a navigation page (EPUB 3)
//                            the table of contents: a name for each place
//
// What is wanted here is the list of pages in reading order, each with its
// path inside the zip and a name. The XML is not parsed into a tree: the few
// tags that matter are picked out as they go by, which is enough for files
// that every reading system must be able to make sense of.
#pragma once

#include <cctype>
#include <map>
#include <string>
#include <vector>

#include "anchor.hpp"
#include "zip.hpp"

namespace epub {

struct Chapter {
  std::string path;    // inside the zip
  std::string title;
};
struct Book {
  std::string title;
  std::vector<Chapter> chapters;
};

// One tag of an XML text: its name without any "prefix:", and what stands between the name and ">".
struct Tag {
  std::string name, attrs;
  size_t end;      // just past its ">"
  bool closing;
};
// The next tag at or after `from`. False when there are no more.
inline bool next_tag(const std::string &xml, size_t from, Tag &tag) {
  for (;;) {
    const size_t open = xml.find('<', from);
    if (open == std::string::npos) return false;
    if (xml.compare(open, 4, "<!--") == 0) { const size_t e = xml.find("-->", open); if (e == std::string::npos) return false; from = e + 3; continue; }
    const size_t close = xml.find('>', open);
    if (close == std::string::npos) return false;
    size_t a = open + 1;
    tag.closing = a < close && xml[a] == '/';
    if (tag.closing) a++;
    size_t b = a;
    while (b < close && !std::isspace(static_cast<unsigned char>(xml[b])) && xml[b] != '/') b++;
    tag.name = xml.substr(a, b - a);
    const size_t colon = tag.name.find(':');
    if (colon != std::string::npos) tag.name.erase(0, colon + 1);
    tag.attrs = xml.substr(b, close - b);
    tag.end = close + 1;
    return true;
  }
}
// The value of an attribute, "" if it is not there. `&amp;` and its kind are undone.
inline std::string attr(const std::string &attrs, const std::string &name) {
  for (size_t at = attrs.find(name); at != std::string::npos; at = attrs.find(name, at + 1)) {
    if (at > 0 && !std::isspace(static_cast<unsigned char>(attrs[at - 1]))) continue;   // the end of a longer name
    size_t i = at + name.size();
    while (i < attrs.size() && std::isspace(static_cast<unsigned char>(attrs[i]))) i++;
    if (i >= attrs.size() || attrs[i] != '=') continue;
    i++;
    while (i < attrs.size() && std::isspace(static_cast<unsigned char>(attrs[i]))) i++;
    if (i >= attrs.size() || (attrs[i] != '"' && attrs[i] != '\'')) continue;
    const size_t end = attrs.find(attrs[i], i + 1);
    if (end == std::string::npos) return "";
    std::string out;
    for (size_t k = i + 1; k < end;) {
      if (attrs[k] == '&') { const size_t took = anchor::entity(attrs, k, out); if (took) { k += took; continue; } }
      out += attrs[k++];
    }
    return out;
  }
  return "";
}
// The words between a tag and the one that closes it, tags inside left out, spaces made single.
inline std::string text_until(const std::string &xml, size_t from, const std::string &closing_name) {
  std::string raw;
  Tag t;
  size_t at = from;
  while (at < xml.size()) {
    const size_t open = xml.find('<', at);
    raw.append(xml, at, open == std::string::npos ? std::string::npos : open - at);
    if (open == std::string::npos || !next_tag(xml, open, t)) break;
    if (t.closing && t.name == closing_name) break;
    at = t.end;
  }
  std::string out;
  for (size_t k = 0; k < raw.size();) {
    if (raw[k] == '&') { const size_t took = anchor::entity(raw, k, out); if (took) { k += took; continue; } }
    const char c = raw[k++];
    if (std::isspace(static_cast<unsigned char>(c))) { if (!out.empty() && out.back() != ' ') out += ' '; }
    else out += c;
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}
// Where a link written in one file of the book leads, as a path inside the
// zip: "%20" undone, any "#place" dropped, "../" followed. "" if it leaves the book.
inline std::string resolve(const std::string &from_file, const std::string &href) {
  std::string link;
  for (size_t i = 0; i < href.size() && href[i] != '#'; i++) {
    if (href[i] == '%' && i + 2 < href.size() && std::isxdigit(static_cast<unsigned char>(href[i + 1])) && std::isxdigit(static_cast<unsigned char>(href[i + 2]))) {
      link += static_cast<char>(std::stoi(href.substr(i + 1, 2), nullptr, 16));
      i += 2;
    } else link += href[i];
  }
  if (link.empty() || link.find("://") != std::string::npos) return "";
  std::vector<std::string> parts;
  const size_t slash = from_file.rfind('/');
  const std::string whole = (link[0] == '/' || slash == std::string::npos ? "" : from_file.substr(0, slash + 1)) + link;
  for (size_t i = 0; i <= whole.size();) {
    size_t e = whole.find('/', i);
    if (e == std::string::npos) e = whole.size();
    const std::string part = whole.substr(i, e - i);
    if (part == "..") { if (parts.empty()) return ""; parts.pop_back(); }
    else if (!part.empty() && part != ".") parts.push_back(part);
    i = e + 1;
  }
  std::string out;
  for (const std::string &p : parts) out += (out.empty() ? "" : "/") + p;
  return out;
}

// The book in a zip that is already listed. `max` is the most any one of the
// small XML files may hold. False if it is not an EPUB that can be read.
inline bool open(const std::string &file, const std::vector<zip::Entry> &entries, Book &book, size_t max) {
  auto load = [&](const std::string &name, std::string &out) { const zip::Entry *e = zip::find(entries, name); return e && zip::read(file, *e, out, max) == 0; };
  std::string xml, opf;
  Tag t;
  if (!load("META-INF/container.xml", xml)) return false;
  for (size_t at = 0; next_tag(xml, at, t); at = t.end) if (t.name == "rootfile" && opf.empty()) opf = resolve("", attr(t.attrs, "full-path"));
  if (opf.empty() || !load(opf, xml)) return false;

  struct Item { std::string path, type, properties; };
  std::map<std::string, Item> manifest;
  std::vector<std::string> spine;
  std::string ncx_id;
  for (size_t at = 0; next_tag(xml, at, t); at = t.end) {
    if (t.closing) continue;
    if (t.name == "title" && book.title.empty()) book.title = text_until(xml, t.end, "title");
    else if (t.name == "item") manifest[attr(t.attrs, "id")] = {resolve(opf, attr(t.attrs, "href")), attr(t.attrs, "media-type"), attr(t.attrs, "properties")};
    else if (t.name == "spine") ncx_id = attr(t.attrs, "toc");
    else if (t.name == "itemref") spine.push_back(attr(t.attrs, "idref"));
  }

  // Names for the pages, from the table of contents: the first name given to each file.
  std::map<std::string, std::string> names;
  std::string toc;
  for (const auto &it : manifest) {
    const Item &item = it.second;
    const bool ncx = item.type == "application/x-dtbncx+xml" || it.first == ncx_id;
    const bool nav = (" " + item.properties + " ").find(" nav ") != std::string::npos;
    if ((!ncx && !nav) || item.path.empty() || !load(item.path, toc)) continue;
    // Only the contents proper: the same files also list page numbers and
    // landmarks ("navMap" beside "pageList"; a "toc" nav beside a "page-list" one).
    std::string label;
    bool contents = false;
    for (size_t at = 0; next_tag(toc, at, t); at = t.end) {
      if (ncx && t.name == "navMap") contents = !t.closing;
      if (nav && t.name == "nav") { const std::string kind = attr(t.attrs, "epub:type"); contents = !t.closing && (kind.empty() || kind == "toc"); }
      if (t.closing || !contents) continue;
      if (ncx && t.name == "text") label = text_until(toc, t.end, "text");
      else if (ncx && t.name == "content") { const std::string to = resolve(item.path, attr(t.attrs, "src")); if (!to.empty() && !label.empty() && !names.count(to)) names[to] = label; }
      else if (nav && t.name == "a") { const std::string to = resolve(item.path, attr(t.attrs, "href")), said = text_until(toc, t.end, "a"); if (!to.empty() && !said.empty() && !names.count(to)) names[to] = said; }
    }
  }

  for (const std::string &id : spine) {
    const auto it = manifest.find(id);
    if (it == manifest.end() || it->second.path.empty() || !zip::find(entries, it->second.path)) continue;
    const std::string &path = it->second.path;
    const auto named = names.find(path);
    std::string title = named != names.end() ? named->second : "";
    if (title.empty()) {   // not in the contents (a cover, a title page): the file's own name
      const size_t slash = path.rfind('/'), dot = path.rfind('.');
      title = path.substr(slash == std::string::npos ? 0 : slash + 1, dot == std::string::npos || (slash != std::string::npos && dot < slash) ? std::string::npos : dot - (slash == std::string::npos ? 0 : slash + 1));
    }
    book.chapters.push_back({path, title});
  }
  return !book.chapters.empty();
}

} // namespace epub
