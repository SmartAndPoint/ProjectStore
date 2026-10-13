#!/usr/bin/env python3
"""ProjectStore site i18n: a few templates, one dictionary per language, one static page per template
and language.

    python3 tools/i18n.py build [--base-url https://projectstore.dev] [--strict]
        Render every template in PAGES with every locales/<lang>.json. English, the default, lives at
        the root (index.html, <slug>/index.html); every other language under <lang>/. The base URL
        defaults to the site's own address, so hreflang, canonical and og:url links are absolute;
        --base-url "" renders them relative. The link-preview image is always absolute.

    python3 tools/i18n.py extract
        Refresh locales/en.json from the English text in the templates. Run it after editing English.
        A key is unique across the site: the same key in two templates must carry the same English
        (the shared partials do, by construction).

    python3 tools/i18n.py check
        Report, per language: missing keys, unknown keys, markup that differs from the English,
        and keys whose English changed since the last extract (their translations may be stale).
        Markup includes the fact markers (data-fact, data-source, data-title, data-slug) and their
        values, so a translation cannot drop or change one. The bind line's language suffix,
        start.bind-lang, is either empty or " --lang <the page's code>" for a language
        ProjectStore ships templates for.

How the template marks text:
    data-i18n="key"                     the element's inner HTML is translated
    data-i18n-attr="name:key;name:key"  attribute values are translated (aria-label, alt, ...)
    <!--i18n:alternates-->              replaced with hreflang alternates and the canonical link
    <!--i18n:switcher-->                replaced with the language switcher
    <!--i18n:redirect-->                replaced, on English pages only, with the language redirect
    <!--i18n:include _name.html-->      replaced, before anything else, with src/_name.html (the
                                        header, the footer and the icon sprite every page shares)

Stdlib only, no dependencies.
"""
import argparse
import html
import json
import os
import re
import sys
from collections import Counter
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
LOCALES = os.path.join(ROOT, "locales")
# The pages, in a fixed order (the order of locales/en.json): each template in src/ and the folder its
# pages live in, under the root for English and under <lang>/ for the others. "" is the language root.
PAGES = [
    {"kind": "main", "src": "index.html", "slug": ""},
]
# The site's own address: hreflang and canonical links are rendered under it by default.
BASE_URL = "https://projectstore.dev"
# The repository's template languages (scripts/binding.mjs languageNames reads the same
# directory). Absent when the site is used outside the repository; the bind-lang rule then
# checks only the form of the suffix.
TEMPLATES = os.path.join(os.path.dirname(ROOT), "templates")
BIND_LANG = "start.bind-lang"

# code, native name, BCP 47 tag used for <html lang> and hreflang. Order = switcher order.
LANGS = [
    ("en", "English", "en"),
    ("de", "Deutsch", "de"),
    ("es", "Español", "es"),
    ("fr", "Français", "fr"),
    ("pt", "Português", "pt-BR"),
    ("ru", "Русский", "ru"),
    ("uk", "Українська", "uk"),
    ("zh", "中文", "zh-CN"),
]
DEFAULT = "en"
COOKIE = "ps_lang"

# Keys that the build uses but that do not live in the template.
SPECIAL = {"_lang.label": "Language"}

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


# --------------------------------------------------------------------------------------------
# A small HTML tree that remembers source offsets, so edits are splices into the original text
# and nothing else in the file is reformatted.
# --------------------------------------------------------------------------------------------

class El:
    __slots__ = ("tag", "attrs", "start", "start_end", "end_start", "end", "children", "parent")

    def __init__(self, tag, attrs, start, start_end, parent):
        self.tag, self.attrs, self.start, self.start_end, self.parent = tag, dict(attrs), start, start_end, parent
        self.end_start = self.end = start_end
        self.children = []

    def classes(self):
        return (self.attrs.get("class") or "").split()

    def iter(self):
        yield self
        for c in self.children:
            if isinstance(c, El):
                yield from c.iter()


class Txt:
    __slots__ = ("start", "end", "parent")

    def __init__(self, start, parent):
        self.start, self.end, self.parent = start, start, parent


class _Parser(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=True)
        self.src = src
        self.lines = [0] + [m.end() for m in re.finditer("\n", src)]
        self.root = El("#root", [], 0, 0, None)
        self.stack = [self.root]
        self.pending = None

    def _off(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def _flush(self, pos):
        if self.pending is not None:
            self.pending.end = pos
            if pos > self.pending.start:
                self.pending.parent.children.append(self.pending)
            self.pending = None

    def handle_starttag(self, tag, attrs):
        pos = self._off()
        self._flush(pos)
        raw = self.get_starttag_text()
        el = El(tag, attrs, pos, pos + len(raw), self.stack[-1])
        self.stack[-1].children.append(el)
        if tag not in VOID:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        pos = self._off()
        self._flush(pos)
        raw = self.get_starttag_text()
        el = El(tag, attrs, pos, pos + len(raw), self.stack[-1])
        self.stack[-1].children.append(el)

    def handle_endtag(self, tag):
        pos = self._off()
        self._flush(pos)
        end = self.src.index(">", pos) + 1
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                for el in self.stack[i + 1:]:
                    el.end_start = el.end = pos
                self.stack[i].end_start, self.stack[i].end = pos, end
                del self.stack[i:]
                return

    def handle_data(self, data):
        if self.pending is None:
            self.pending = Txt(self._off(), self.stack[-1])

    def handle_comment(self, data):
        self._flush(self._off())

    def handle_decl(self, decl):
        self._flush(self._off())

    def handle_pi(self, data):
        self._flush(self._off())

    def unknown_decl(self, data):
        self._flush(self._off())

    def finish(self):
        self.close()
        self._flush(len(self.src))
        for el in self.stack[1:]:
            el.end_start = el.end = len(self.src)
        return self.root


def parse(src):
    p = _Parser(src)
    p.feed(src)
    return p.finish()


def inner(src, el):
    return src[el.start_end:el.end_start]


def attr_pairs(spec):
    out = []
    for part in (spec or "").split(";"):
        part = part.strip()
        if part:
            name, key = part.split(":", 1)
            out.append((name.strip(), key.strip()))
    return out


def set_attr(tag_raw, name, value):
    rx = re.compile(r"(\s" + re.escape(name) + r"\s*=\s*)(\"[^\"]*\"|'[^']*')", re.I)
    esc = html.escape(value, quote=True)
    if not rx.search(tag_raw):
        raise ValueError(f"attribute {name} not found in {tag_raw[:80]}")
    return rx.sub(lambda m: f' {name}="{esc}"', tag_raw, count=1)


def collect(src, tree):
    """Return (inner, attrs): {key: (el)} for data-i18n, and [(el, [(name, key)])] for data-i18n-attr."""
    inner_keys, attr_keys = {}, []
    for el in tree.iter():
        k = el.attrs.get("data-i18n")
        if k:
            if k in inner_keys:
                raise SystemExit(f"duplicate key in template: {k}")
            inner_keys[k] = el
        spec = el.attrs.get("data-i18n-attr")
        if spec:
            attr_keys.append((el, attr_pairs(spec)))
    return inner_keys, attr_keys


INCLUDE = re.compile(r"<!--i18n:include (_[a-z0-9-]+\.html)-->\n?")


def load_template(name):
    """A template with its partials spliced in: the parser and every offset see one document."""
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        src = f.read()

    def part(m):
        with open(os.path.join(SRC, m.group(1)), encoding="utf-8") as f:
            return f.read()

    return INCLUDE.sub(part, src)


def page_dict(src):
    tree = parse(src)
    inner_keys, attr_keys = collect(src, tree)
    d = {}
    for k, el in inner_keys.items():
        d[k] = inner(src, el)
    for el, pairs in attr_keys:
        for name, key in pairs:
            d[key] = el.attrs.get(name, "")
    return d


def extract_dict(sources):
    """The English dictionary of the whole site: every page's keys, in PAGES order."""
    d = {}
    for name, src in sources:
        for k, v in page_dict(src).items():
            if k in d and d[k] != v:
                raise SystemExit(f"key {k} has different English in {name} and an earlier template")
            d.setdefault(k, v)
    d.update(SPECIAL)
    return d


def templates():
    return [(p["src"], load_template(p["src"])) for p in PAGES]


# --------------------------------------------------------------------------------------------
# Markup signature: translations may reword freely but must keep the same elements.
# --------------------------------------------------------------------------------------------

class _Sig(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.c = Counter()

    # Free to add, drop or move: line breaks and plain inline formatting. Must be kept: anything
    # with a class, links, icons, spans and the <b> highlight that marks a thesis.
    FREE = {"br", "code", "em", "i", "strong", "small"}
    # The markers the site test reads. Their values are counted on any element, so a
    # translation that drops, adds or changes one differs from the English.
    MARKERS = ("data-fact", "data-source", "data-title", "data-slug")

    def _add(self, tag, attrs):
        a = dict(attrs)
        for m in self.MARKERS:
            if m in a:
                self.c[(m, a[m] or "")] += 1
        if tag in self.FREE and not a.get("class"):
            return
        self.c[(tag, a.get("class", ""), a.get("href", ""))] += 1

    def handle_starttag(self, tag, attrs):
        self._add(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        self._add(tag, attrs)


def signature(value):
    p = _Sig()
    p.feed(value)
    p.close()
    return p.c


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------

def load_locale(code):
    path = os.path.join(LOCALES, f"{code}.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def page_path(code, slug):
    """A page's folder under the site root: "", "de/", "how-it-works/", "de/how-it-works/"."""
    return ("" if code == DEFAULT else f"{code}/") + (f"{slug}/" if slug else "")


def depth(code, slug):
    return page_path(code, slug).count("/")


def page_url(code, from_code, slug, base_url):
    """The address of the page `slug` in language `code`, as seen from that page in `from_code`."""
    if base_url:
        return base_url.rstrip("/") + "/" + page_path(code, slug)
    return "../" * depth(from_code, slug) + page_path(code, slug) or "./"


def alternates(code, slug, base_url):
    lines = []
    for c, _, tag in LANGS:
        lines.append(f'<link rel="alternate" hreflang="{tag}" href="{page_url(c, code, slug, base_url)}">')
    lines.append(f'<link rel="alternate" hreflang="x-default" href="{page_url(DEFAULT, code, slug, base_url)}">')
    lines.append(f'<link rel="canonical" href="{page_url(code, code, slug, base_url)}">')
    return "\n".join(lines)


# The separator between the switcher's label and the language name, where the language's own
# typography differs from ": " — French sets a narrow no-break space before the colon, Chinese a
# full-width colon with no space.
LABEL_SEPARATOR = {"fr": "\u202f: ", "zh": "："}


def switcher(code, slug, label):
    native = dict((c, n) for c, n, _ in LANGS)[code]
    sep = LABEL_SEPARATOR.get(code, ": ")
    items = []
    for c, name, tag in LANGS:
        cur = ' aria-current="true"' if c == code else ""
        items.append(
            f'<li><a href="{page_url(c, code, slug, None)}" hreflang="{tag}" lang="{tag}" data-lang="{c}"{cur}>{name}</a></li>'
        )
    return (
        '<div class="lang-switch">'
        f'<button class="lang" type="button" aria-expanded="false" aria-controls="lang-menu" '
        f'aria-label="{html.escape(label)}{sep}{html.escape(native)}">'
        '<svg class="icon sm" aria-hidden="true"><use href="#i-globe"/></svg>'
        f"<span>{code.upper()}</span>"
        '<svg class="icon sm lang-chev" aria-hidden="true"><use href="#i-chevron"/></svg></button>'
        f'<ul class="lang-menu" id="lang-menu" hidden>{"".join(items)}</ul>'
        "</div>"
    )


def redirect_script(slug):
    """On an English page: go to the same page in the visitor's language, if they have a reason to want one."""
    others = ",".join(f'"{c}":1' for c, _, _ in LANGS if c != DEFAULT)
    up = "../" * depth(DEFAULT, slug)
    target = (f"'{up}'+t+'/{slug}/'" if slug else "t+'/'")
    return (
        "<script>(function(){"
        f"var L={{{others}}};"
        f'var m=document.cookie.match(/(?:^|; ){COOKIE}=([a-z]{{2}})/),c=m&&m[1],t=null;'
        "if(c){if(L[c])t=c;}else{"
        "var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||''];"
        "for(var i=0;i<a.length;i++){var p=String(a[i]).toLowerCase().split('-')[0];"
        f"if(p==='{DEFAULT}')break;if(L[p]){{t=p;break;}}}}}}"
        f"if(t){{location.replace({target}+(location.protocol==='file:'?'index.html':'')+location.search+location.hash);}}"
        "})();</script>"
    )


def asset_versions():
    """Short content hashes for CSS and JS, appended as ?v= so browsers drop stale copies."""
    import hashlib
    out = {}
    for rel in ("assets/style.css", "assets/site.js"):
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            with open(path, "rb") as f:
                out[rel] = hashlib.sha1(f.read()).hexdigest()[:8]
    return out


# A relative href or src in a template is written from the language root (where the English main page
# is). On a page deeper than that, it is prefixed with one "../" per level; "./" alone, the main page,
# becomes the prefix itself.
REL_URL = re.compile(r"""(\s(?:href|src)=)(["'])(?!#|[a-zA-Z][a-zA-Z0-9+.-]*:|/|\.\./)(\./(?=["'#?]))?""")


def render(src, inner_keys, attr_keys, code, slug, d, en, base_url, warn):
    reps = []
    for key, el in inner_keys.items():
        val = d.get(key)
        if val is None:
            val = en[key]
            warn.append(f"{code}: missing {key}, English used")
        reps.append((el.start_end, el.end_start, val))
    for el, pairs in attr_keys:
        raw = src[el.start:el.start_end]
        for name, key in pairs:
            val = d.get(key)
            if val is None:
                val = en.get(key, el.attrs.get(name, ""))
                warn.append(f"{code}: missing {key}, English used")
            raw = set_attr(raw, name, val)
        reps.append((el.start, el.start_end, raw))
    out = src
    for start, end, val in sorted(reps, key=lambda r: r[0], reverse=True):
        out = out[:start] + val + out[end:]

    for rel, v in asset_versions().items():
        out = out.replace(f'"{rel}"', f'"{rel}?v={v}"')
    tag = dict((c, t) for c, _, t in LANGS)[code]
    out = re.sub(r'<html lang="[^"]*"', f'<html lang="{tag}"', out, count=1)
    up = "../" * depth(code, slug)
    if up:
        out = REL_URL.sub(lambda m: f"{m.group(1)}{m.group(2)}{up}", out)
    out = out.replace("<!--i18n:alternates-->", alternates(code, slug, base_url))
    out = out.replace("<!--i18n:switcher-->", switcher(code, slug, d.get("_lang.label") or SPECIAL["_lang.label"]))
    out = out.replace("<!--i18n:redirect-->", redirect_script(slug) if code == DEFAULT else "")
    return out


def cmd_build(args):
    sources = templates()
    en = extract_dict(sources)
    dicts = {code: (en if code == DEFAULT else load_locale(code)) for code, _, _ in LANGS}
    warn, written = [], []
    for code, d in dicts.items():
        if d is None:
            warn.append(f"{code}: no locales/{code}.json, page not built")
    for page, (_, src) in zip(PAGES, sources):
        tree = parse(src)
        inner_keys, attr_keys = collect(src, tree)
        for code, _, _ in LANGS:
            d = dicts[code]
            if d is None:
                continue
            out = render(src, inner_keys, attr_keys, code, page["slug"], d, en, args.base_url, warn)
            rel = page_path(code, page["slug"]) + "index.html"
            path = os.path.join(ROOT, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            written.append(rel)
    # The old /en/ address now points at the root, where English lives.
    stub = os.path.join(ROOT, "en", "index.html")
    os.makedirs(os.path.dirname(stub), exist_ok=True)
    with open(stub, "w", encoding="utf-8") as f:
        f.write(
            '<!doctype html><meta charset="utf-8"><title>ProjectStore</title>'
            '<link rel="canonical" href="../"><meta http-equiv="refresh" content="0; url=../">'
            '<a href="../">ProjectStore</a>\n'
        )
    for w in warn:
        print("warning:", w, file=sys.stderr)
    print("built:", ", ".join(written))
    return 1 if any("missing" in w for w in warn) and args.strict else 0


def cmd_extract(args):
    d = extract_dict(templates())
    os.makedirs(LOCALES, exist_ok=True)
    with open(os.path.join(LOCALES, "en.json"), "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"locales/en.json: {len(d)} keys")
    return 0


def bind_lang_problem(code, value):
    """The bind line's suffix: empty, or " --lang <code>" where ProjectStore ships templates."""
    if value in (None, ""):
        return None
    if value != f" --lang {code}":
        return f'{BIND_LANG} is {value!r}: it is "" or " --lang {code}"'
    if os.path.isdir(TEMPLATES) and not os.path.isdir(os.path.join(TEMPLATES, code)):
        return f"{BIND_LANG}: ProjectStore ships no templates/{code}/, so the bind line takes no --lang"
    return None


def cmd_check(args):
    en = extract_dict(templates())
    snapshot = load_locale("en") or {}
    problems = 0
    bad = bind_lang_problem(DEFAULT, en.get(BIND_LANG))
    if bad:
        print(f"{DEFAULT}: {bad}")
        problems += 1
    stale = sorted(k for k in en if k in snapshot and snapshot[k] != en[k])
    new = sorted(k for k in en if k not in snapshot)
    if stale or new:
        print(f"en: {len(stale)} keys changed and {len(new)} keys added since locales/en.json was extracted")
        for k in stale + new:
            print("   ", k)
    for code, _, _ in LANGS:
        if code == DEFAULT:
            continue
        d = load_locale(code)
        if d is None:
            print(f"{code}: no locales/{code}.json")
            problems += 1
            continue
        missing = sorted(set(en) - set(d))
        extra = sorted(set(d) - set(en))
        markup = sorted(k for k in en if k in d and signature(en[k]) != signature(d[k]))
        outdated = [k for k in stale if k in d]
        bad = bind_lang_problem(code, d.get(BIND_LANG))
        n = len(missing) + len(extra) + len(markup) + (1 if bad else 0)
        problems += n
        status = "ok" if n == 0 else f"{n} problems"
        print(f"{code}: {len(d)} keys, {status}" + (f", {len(outdated)} possibly stale" if outdated else ""))
        for label, keys in (("missing", missing), ("unknown", extra), ("markup differs", markup), ("stale", outdated)):
            for k in keys:
                print(f"    {label}: {k}")
        if bad:
            print(f"    {bad}")
    return 1 if problems else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--base-url", default=BASE_URL,
                   help=f'absolute site URL for hreflang and canonical links (default {BASE_URL}; "" for relative)')
    b.add_argument("--strict", action="store_true", help="exit 1 when a translation is missing")
    sub.add_parser("extract")
    sub.add_parser("check")
    args = ap.parse_args()
    return {"build": cmd_build, "extract": cmd_extract, "check": cmd_check}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
