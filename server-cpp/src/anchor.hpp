// Where a highlight belongs in a document.
//
// A document is taken as a row of blocks: a paragraph, a heading, a list item,
// a table cell, a block of code. Each block is known by a hash of its text
// with everything but letters and digits removed ("folded"), so that the same
// paragraph has the same hash however it was spaced, wrapped or punctuated,
// and whichever file or version it is found in. Blocks with the same text are
// told apart by `nth`: 0 for the first, 1 for the second, and so on.
//
// A highlight then says: this block, this far in, these words. The reader
// page works out the same hashes from the page as it is shown (hub/app.js,
// "anchors"), and places the highlight; the two must fold and hash alike:
//
//   fold   keep ASCII letters (lowered) and digits, and everything outside
//          ASCII except spaces and general punctuation (U+00A0, U+1680,
//          U+2000 to U+206F, U+3000, U+FEFF)
//   hash   FNV-1a, 64 bits, over the folded text as UTF-8; 16 hex digits
//   block  text between the starts and ends of block-level elements
//
// For HTML the blocks here are those of the page. For markdown they are read
// from the source, which matches what the page shows for ordinary writing; an
// unusual construction may give a block another hash, and the highlight is
// then placed by its words and what stands around them.
#pragma once

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace anchor {

inline std::string fold(const std::string &s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    if (c < 0x80) {
      if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')) out += static_cast<char>(c);
      else if (c >= 'A' && c <= 'Z') out += static_cast<char>(c + 32);
      i++;
      continue;
    }
    size_t n = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
    if (i + n > s.size()) n = s.size() - i;
    uint32_t cp = n == 1 ? c : static_cast<uint32_t>(c & (0xFF >> (n + 1)));
    for (size_t k = 1; k < n; k++) cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    const bool dropped = cp == 0xA0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x206F) || cp == 0x3000 || cp == 0xFEFF;
    if (!dropped) out.append(s, i, n);
    i += n;
  }
  return out;
}

inline std::string hash(const std::string &folded) {
  uint64_t h = 14695981039346656037ULL;
  for (unsigned char c : folded) { h ^= c; h *= 1099511628211ULL; }
  char hex[17];
  std::snprintf(hex, sizeof hex, "%016llx", static_cast<unsigned long long>(h));
  return hex;
}

struct Block {
  std::string hash;
  int nth;      // how many earlier blocks have the same hash
  size_t len;   // bytes of folded text
};

// The blocks of a document, from the text of each. Blocks with nothing left after folding are not counted.
inline std::vector<Block> blocks(const std::vector<std::string> &texts) {
  std::vector<Block> out;
  std::map<std::string, int> seen;
  for (const std::string &t : texts) {
    const std::string f = fold(t);
    if (f.empty()) continue;
    const std::string h = hash(f);
    out.push_back({h, seen[h]++, f.size()});
  }
  return out;
}

// ---- small helpers ---------------------------------------------------------

inline bool is_block_tag(const std::string &name) {
  static const char *tags[] = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "td", "th", "dt", "dd", "blockquote", "figcaption", "div", "section",
                               "article", "main", "aside", "header", "footer", "nav", "body", "details", "summary", "caption", "address", "form", "ul", "ol",
                               "dl", "table", "thead", "tbody", "tr", "figure"};
  for (const char *t : tags) if (name == t) return true;
  return false;
}
inline void add_utf8(std::string &out, uint32_t cp) {
  if (cp < 0x80) out += static_cast<char>(cp);
  else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
  else if (cp < 0x110000) { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
}
// "&amp;" and its kind, at s[i]. Returns how many bytes it took, 0 if this is not one.
inline size_t entity(const std::string &s, size_t i, std::string &out) {
  const size_t end = s.find(';', i);
  if (end == std::string::npos || end - i > 10 || end - i < 2) return 0;
  const std::string name = s.substr(i + 1, end - i - 1);
  static const std::map<std::string, uint32_t> named = {{"amp", '&'}, {"lt", '<'}, {"gt", '>'}, {"quot", '"'}, {"apos", '\''}, {"nbsp", 0xA0},
                                                        {"mdash", 0x2014}, {"ndash", 0x2013}, {"hellip", 0x2026}, {"lsquo", 0x2018}, {"rsquo", 0x2019},
                                                        {"ldquo", 0x201C}, {"rdquo", 0x201D}, {"copy", 0xA9}, {"times", 0xD7}};
  if (name[0] == '#') {
    const bool hex = name.size() > 1 && (name[1] == 'x' || name[1] == 'X');
    uint32_t cp = 0;
    size_t k = hex ? 2 : 1;
    if (k >= name.size()) return 0;
    for (; k < name.size(); k++) {
      const char c = name[k];
      const int d = c >= '0' && c <= '9' ? c - '0' : hex && c >= 'a' && c <= 'f' ? c - 'a' + 10 : hex && c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
      if (d < 0 || cp > 0x110000) return 0;
      cp = cp * (hex ? 16 : 10) + static_cast<uint32_t>(d);
    }
    add_utf8(out, cp);
    return end - i + 1;
  }
  const auto it = named.find(name);
  if (it == named.end()) return 0;
  add_utf8(out, it->second);
  return end - i + 1;
}
inline bool starts_tag(const std::string &s, size_t i) {
  if (i + 1 >= s.size()) return false;
  const unsigned char c = static_cast<unsigned char>(s[i + 1]);
  return c == '/' || c == '!' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// ---- HTML ------------------------------------------------------------------
// The text of each block of a page: what stands between the starts and ends
// of block-level elements. Scripts, styles and comments are not text.
inline std::vector<std::string> html_blocks(const std::string &src) {
  std::vector<std::string> out;
  std::string cur;
  auto flush = [&] { if (!cur.empty()) out.push_back(cur); cur.clear(); };
  auto lowered = [](std::string t) { for (char &c : t) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32); return t; };
  size_t i = 0, stop = src.size();
  // Only the body is shown.
  const std::string low = lowered(src);
  const size_t body = low.find("<body");
  if (body != std::string::npos) {
    const size_t open = src.find('>', body), close = low.rfind("</body");
    if (open != std::string::npos) i = open + 1;
    if (close != std::string::npos && close > i) stop = close;
  }
  while (i < stop) {
    const char c = src[i];
    if (c == '<' && src.compare(i, 4, "<!--") == 0) { const size_t e = src.find("-->", i + 4); i = e == std::string::npos ? stop : e + 3; continue; }
    if (c == '<' && starts_tag(src, i)) {
      size_t e = i + 1;
      char quote = 0;
      for (; e < stop; e++) {   // to the '>' that is not inside an attribute's quotes
        if (quote) { if (src[e] == quote) quote = 0; }
        else if (src[e] == '"' || src[e] == '\'') quote = src[e];
        else if (src[e] == '>') break;
      }
      size_t n = i + 1;
      const bool closing = src[n] == '/';
      if (closing) n++;
      size_t m = n;
      while (m < e && (std::isalnum(static_cast<unsigned char>(src[m])))) m++;
      const std::string name = lowered(src.substr(n, m - n));
      i = e < stop ? e + 1 : stop;
      if (!closing && (name == "script" || name == "style" || name == "noscript")) {
        const size_t done = low.find("</" + name, i);
        const size_t after = done == std::string::npos ? std::string::npos : src.find('>', done);
        i = after == std::string::npos ? stop : after + 1;
        continue;
      }
      if (is_block_tag(name)) flush();
      continue;
    }
    if (c == '&') { const size_t took = entity(src, i, cur); if (took) { i += took; continue; } }
    cur += c;
    i++;
  }
  flush();
  return out;
}

// ---- markdown ----------------------------------------------------------------
// A line or paragraph of markdown as the words a reader sees: a link without
// its address, no pictures, no tags, "&amp;" as "&". The marks of emphasis are
// left in: folding removes them.
inline std::string inline_text(const std::string &s) {
  std::string out;
  for (size_t i = 0; i < s.size();) {
    const char c = s[i];
    if (c == '\\' && i + 1 < s.size()) { out += s[i + 1]; i += 2; continue; }
    if (c == '`') {   // code: as written, up to the same number of backticks
      size_t run = i;
      while (run < s.size() && s[run] == '`') run++;
      const size_t close = s.find(s.substr(i, run - i), run);
      if (close == std::string::npos) { out.append(s, i, run - i); i = run; continue; }
      out.append(s, run, close - run);
      i = close + (run - i);
      continue;
    }
    const bool image = c == '!' && i + 1 < s.size() && s[i + 1] == '[';
    if (c == '[' || image) {
      const size_t open = image ? i + 1 : i;
      size_t close = open + 1;
      for (int depth = 1; close < s.size(); close++) {
        if (s[close] == '\\') { close++; continue; }
        if (s[close] == '[') depth++;
        else if (s[close] == ']' && --depth == 0) break;
      }
      if (close < s.size() && close + 1 < s.size() && (s[close + 1] == '(' || s[close + 1] == '[')) {
        const char shut = s[close + 1] == '(' ? ')' : ']';
        size_t end = close + 2;
        for (int depth = 1; end < s.size(); end++) {
          if (s[end] == '\\') { end++; continue; }
          if (s[end] == s[close + 1]) depth++;
          else if (s[end] == shut && --depth == 0) break;
        }
        if (end < s.size()) {
          if (!image) out += inline_text(s.substr(open + 1, close - open - 1));
          i = end + 1;
          continue;
        }
      }
    }
    if (c == '<' && starts_tag(s, i)) {
      const size_t e = s.find('>', i);
      if (e != std::string::npos) {
        const std::string inner = s.substr(i + 1, e - i - 1);
        // <https://…> is an address written out; anything else is a tag.
        if (inner.find(' ') == std::string::npos && (inner.find("://") != std::string::npos || inner.compare(0, 7, "mailto:") == 0)) out += inner;
        i = e + 1;
        continue;
      }
    }
    if (c == '&') { const size_t took = entity(s, i, out); if (took) { i += took; continue; } }
    out += c;
    i++;
  }
  return out;
}

// The text of each block of a markdown file, read from its source.
inline std::vector<std::string> markdown_blocks(const std::string &src) {
  std::vector<std::string> lines;
  for (size_t i = 0; i <= src.size();) {
    size_t e = src.find('\n', i);
    if (e == std::string::npos) e = src.size();
    std::string line = src.substr(i, e - i);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    lines.push_back(line);
    i = e + 1;
  }
  std::vector<std::string> out;
  std::string para, code;
  bool fenced = false, table = false;
  char fence = 0;
  auto flush = [&] { if (!para.empty()) out.push_back(inline_text(para)); para.clear(); };
  auto only = [](const std::string &t, const char *chars) { return !t.empty() && t.find_first_not_of(chars) == std::string::npos; };
  auto is_rule = [&](const std::string &t) { return only(t, "|-: \t") && t.find('-') != std::string::npos && t.find('|') != std::string::npos; };
  auto cells = [&](const std::string &t) {
    std::string cell;
    for (size_t i = 0; i <= t.size(); i++) {
      if (i < t.size() && t[i] == '\\' && i + 1 < t.size() && t[i + 1] == '|') { cell += '|'; i++; continue; }
      if (i == t.size() || t[i] == '|') { out.push_back(inline_text(cell)); cell.clear(); continue; }
      cell += t[i];
    }
  };
  for (size_t n = 0; n < lines.size(); n++) {
    std::string t = lines[n];
    // Quoted text is text: the ">" in front is dropped, and the space before
    // the first word with it. This is done to lines of code as well, since a
    // fence can stand inside a quotation; neither counts once the text is folded.
    for (;;) {
      const size_t a = t.find_first_not_of(" \t");
      if (a == std::string::npos || t[a] != '>') { t = a == std::string::npos ? "" : t.substr(a); break; }
      t = t.substr(a + 1);
    }
    if (fenced) {
      if (t.compare(0, 3, std::string(3, fence)) == 0) { out.push_back(code); code.clear(); fenced = false; }
      else code += t + "\n";
      continue;
    }
    if (t.empty()) { flush(); table = false; continue; }
    if (t.compare(0, 3, "```") == 0 || t.compare(0, 3, "~~~") == 0) { flush(); fenced = true; fence = t[0]; continue; }
    if (table) { if (t.find('|') != std::string::npos) { if (!is_rule(t)) cells(t); continue; } table = false; }
    if (t.find('|') != std::string::npos && n + 1 < lines.size() && is_rule(lines[n + 1])) { flush(); table = true; cells(t); continue; }
    if (t[0] == '#') {
      const size_t h = t.find_first_not_of('#');
      if (h != std::string::npos && h <= 6 && (t[h] == ' ' || t[h] == '\t')) { flush(); out.push_back(inline_text(t.substr(h))); continue; }
    }
    // A line under a heading (=== or ---) or a rule across the page: it ends the paragraph and has no words.
    if (only(t, "= \t") || (only(t, "-_* \t") && t.size() >= 3)) { flush(); continue; }
    // "[name]: address" says where a link goes and is not shown.
    if (t[0] == '[' && t.find("]:") != std::string::npos && para.empty()) continue;
    // A list item begins a block of its own.
    size_t m = 0;
    if (t.size() > 1 && (t[0] == '-' || t[0] == '*' || t[0] == '+') && (t[1] == ' ' || t[1] == '\t')) m = 2;
    else {
      size_t d = 0;
      while (d < t.size() && d < 9 && t[d] >= '0' && t[d] <= '9') d++;
      if (d && d + 1 < t.size() && (t[d] == '.' || t[d] == ')') && (t[d + 1] == ' ' || t[d + 1] == '\t')) m = d + 2;
    }
    if (m) {
      flush();
      t = t.substr(m);
      const size_t a = t.find_first_not_of(" \t");
      if (a != std::string::npos && t.compare(a, 3, "[ ]") == 0) t = t.substr(a + 3);
      else if (a != std::string::npos && (t.compare(a, 3, "[x]") == 0 || t.compare(a, 3, "[X]") == 0)) t = t.substr(a + 3);
    }
    para += (para.empty() ? "" : "\n") + t;
  }
  if (fenced) out.push_back(code);
  flush();
  return out;
}

} // namespace anchor
