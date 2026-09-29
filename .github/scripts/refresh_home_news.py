#!/usr/bin/env python3
"""Pull TAO Daily RSS into brief/news.json for the Home ticker."""
from __future__ import annotations

import html
import json
import re
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET

FEED = "https://taodaily.io/feed/"
OUT = Path(__file__).resolve().parents[2] / "brief" / "news.json"
NS = {"content": "http://purl.org/rss/1.0/modules/content/"}


def text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def strip_html(s: str) -> str:
    s = re.sub(r"(?is)<script.*?>.*?</script>", " ", s or "")
    s = re.sub(r"(?is)<style.*?>.*?</style>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def clean_body(s: str) -> str:
    t = strip_html(s)
    t = re.sub(r"\[\.\.\.\]\s*", "", t)
    t = re.sub(r"The post\b.*$", "", t, flags=re.I).strip()
    if len(t) > 160:
        t = t[:157].rsplit(" ", 1)[0] + "…"
    return t


def fmt_when(pub: str) -> str:
    try:
        dt = parsedate_to_datetime(pub)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        return dt.strftime("%b ") + str(dt.day)
    except Exception:
        return pub[:12] if pub else ""


def sn_from(title: str, body: str):
    m = re.search(r"\bSN\s*(\d{1,3})\b", f"{title} {body}", re.I)
    return int(m.group(1)) if m else None


def parse(xml: bytes) -> list[dict]:
    root = ET.fromstring(xml)
    items = []
    for it in root.findall("./channel/item")[:6]:
        title = strip_html(text(it.find("title")))
        link = text(it.find("link"))
        raw = text(it.find("description")) or text(it.find("content:encoded", NS))
        body = clean_body(raw)
        if not title or not link:
            continue
        items.append({
            "when": fmt_when(text(it.find("pubDate"))),
            "title": title,
            "body": body,
            "href": link,
            "sn": sn_from(title, body),
        })
    return items


def main() -> None:
    req = urllib.request.Request(FEED, headers={"User-Agent": "SubnetBrief/1.0 (+https://subnetbriefs.com)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        xml = r.read()
    items = parse(xml)
    if not items:
        raise SystemExit("no news items parsed")
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": FEED,
        "items": items,
    }
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
            if old.get("items") == items:
                print("news unchanged")
                return
        except Exception:
            pass
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(items)} items)")


if __name__ == "__main__":
    main()
