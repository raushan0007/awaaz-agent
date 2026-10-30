"""Fill a fresh Awaaz database with two weeks of realistic Supaul reports, through the real API.

Every report goes through the live agent (Muse Spark), so routing, urgency, duplicate merging and
the Hindi letters are all real model output; officers then act through the officer API, so every
citizen update is written by Muse Spark Open. The only thing changed afterwards is the timestamps,
spread over the last 14 days so the dashboard has history.

Usage (server running on a fresh database, officers created with scripts/seed_officers.py):
    python scripts/seed_demo.py [--base http://localhost:8010]
Costs roughly $0.50 of model calls; the daily budget guard still applies.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.config import settings  # noqa: E402

# (days ago, report text, area, officer actions as (status, note, hours after filing))
REPORTS: list[tuple[float, str, str, list[tuple[str, str, float]]]] = [
    (13.5, "Station Road par railway gate ke paas sadak mein bahut bade gaddhe hain, auto palat gaya tha pichhle hafte.",
     "Ward 7, Supaul", [("in_progress", "JE ne site dekhi, estimate bana diya", 20), ("resolved", "Gaddhe bhar diye gaye, roller chala diya", 70)]),
    (13.0, "हमारे मोहल्ले में 4 दिन से नल में पानी नहीं आ रहा है, लोग हैंडपंप से पानी ला रहे हैं।",
     "वार्ड 3, सुपौल", [("in_progress", "Pump motor jal gayi thi, nayi motor mangwayi", 6), ("resolved", "Nayi motor lag gayi, supply chalu", 30)]),
    (12.2, "Mahaveer Chowk ke paas kooda 10 din se nahi utha, badbu aa rahi hai aur suar ghoom rahe hain.",
     "Ward 11, Supaul", [("resolved", "Safai karmi bheje, kooda utha liya gaya", 18)]),
    (11.8, "Gandhi Maidan ke chaaron taraf ki 6 street light band hain, raat ko andhera rehta hai, ladkiyon ko darr lagta hai.",
     "Ward 9, Supaul", [("in_progress", "Electrician ko list di gayi", 10)]),
    (11.0, "Lohia Nagar mein naala jam hai, ganda paani sadak par beh raha hai aur gharon mein ghus raha hai.",
     "Ward 14, Supaul", [("in_progress", "JCB se naala saaf karwana shuru", 26), ("resolved", "Naala saaf, paani nikal gaya", 50)]),
    (10.4, "Transformer 3 din se jala hua hai, pure tole mein bijli nahi hai. Mera number 9876543210 hai, zarurat ho to call karein.",
     "Ward 18, Supaul", [("in_progress", "Naya transformer issue ho gaya, kal lagega", 12), ("resolved", "Transformer badal diya, supply chalu", 36)]),
    (9.6, "Station road wali sadak ke gaddhe ab aur bade ho gaye, railway gate ke saamne roz jaam lagta hai",
     "ward 7 supaul", []),
    (9.1, "Sadar Hospital road par ek manhole ka dhakkan toota hua hai, raat mein koi gir sakta hai, bahut khatarnak hai.",
     "Ward 5, Supaul", [("in_progress", "Barricade laga diya, naya dhakkan order kiya", 3)]),
    (8.5, "Primary school ke bagal mein handpump 2 hafte se kharab hai, bachche paani nahi pee pa rahe.",
     "Ward 21, Supaul", []),
    (8.0, "बस स्टैंड के सामने कूड़े का बड़ा ढेर है, मच्छर बहुत हो गए हैं।",
     "Ward 2, Supaul", [("in_progress", "Kooda gaadi bheji", 8)]),
    (7.4, "Kosi colony mein bijli ka taar ek ghar ki chhat ke bahut paas latak raha hai, baarish mein current aata hai.",
     "Ward 16, Supaul", [("in_progress", "Lineman bheja, taar uthaya ja raha hai", 2), ("resolved", "Taar sahi height par baandh diya", 9)]),
    (6.9, "Gandhi Maidan ki lights abhi bhi band hain, kal raat ek chain snatching hui.",
     "Ward 9 Supaul", []),
    (6.2, "Collectorate road par pipeline phat gayi hai, saaf paani bah raha hai aur sadak bhi toot rahi hai.",
     "Ward 1, Supaul", [("in_progress", "PHED team pahunchi, joint badla ja raha hai", 4)]),
    (5.8, "Sasta loan sirf 2 minute mein! Abhi apply karein, koi document nahi chahiye.",
     "", []),
    (5.1, "Hamare ward mein naali ka paani peene ke paani ki pipe mein mil raha hai, nal se badbudaar paani aa raha hai, kai log bimaar.",
     "Ward 23, Supaul", [("in_progress", "Pipe leak dhundha ja raha hai, tanker bheja", 5)]),
    (4.6, "Mahaveer chowk par phir se kooda jama hai, roz uthana chahiye",
     "Ward 11, Supaul", []),
    (4.0, "The road from Kachahari to Ward 20 is completely broken after the rains, school buses cannot pass.",
     "Ward 20, Supaul", []),
    (3.5, "Lohia Nagar naala phir se jam ho gaya, kal ki baarish mein paani ghar tak aa gaya",
     "Ward 14, Supaul", []),
    (3.1, "Durga Mandir ke paas street light din mein bhi jalti rehti hai aur raat ko band ho jaati hai.",
     "Ward 6, Supaul", []),
    (2.6, "मेरे घर के पास का बिजली का खंभा झुक गया है, कभी भी गिर सकता है, नीचे दुकानें हैं।",
     "वार्ड 12, सुपौल", [("in_progress", "JE ko site par bheja", 4)]),
    (2.1, "Sabzi mandi mein naali band hai aur kooda bhara hai, gandagi se dukaandar pareshan hain.",
     "Ward 4, Supaul", []),
    (1.6, "Manhole wali jagah par abhi tak dhakkan nahi laga, sirf ek lakdi rakhi hai",
     "Ward 5, Supaul", []),
    (1.2, "Ward 19 ke tole mein 2 din se bijli 18 ghante kat rahi hai, bachchon ki padhai ruk gayi hai.",
     "Ward 19, Supaul", []),
    (0.8, "Station Road par gaddhe, aaj subah ek cycle wala gir gaya. Kab theek hoga?",
     "Ward 7, Supaul", []),
    (0.5, "Kachahari road par pedon ki daal bijli ke taar par gir gayi hai, chingari nikal rahi hai.",
     "Ward 8, Supaul", []),
    (0.2, "Ward 3 mein phir se paani ki supply band hai, aaj subah se nal sookha hai.",
     "Ward 3, Supaul", []),
]


def officer_tokens(client: httpx.Client) -> dict[str, str]:
    """Log in every officer listed by seed_officers.py; returns {department: token}."""
    tokens = {}
    for line in (settings.data_dir / "officers.local.txt").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 3 or line.startswith("#"):
            continue
        username, password, department = parts
        r = client.post("/api/officer/login", json={"username": username, "password": password})
        r.raise_for_status()
        tokens[department] = r.json()["token"]
    return tokens


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8010")
    args = parser.parse_args()
    client = httpx.Client(base_url=args.base, timeout=240)
    if client.get("/api/complaints", params={"limit": 1}).json():
        sys.exit("The database already has complaints; start the server on a fresh database first.")
    tokens = officer_tokens(client)

    # Replay reports and officer actions in time order, so a report filed after a fix is not merged
    # into the already-resolved complaint.
    events = []
    for n, (days_ago, text, area, actions) in enumerate(REPORTS):
        events.append((-days_ago * 24, "file", n, None))
        for k, (_, _, hours) in enumerate(actions):
            events.append((-days_ago * 24 + hours, "act", n, k))
    events.sort(key=lambda e: e[0])

    ids: dict[int, int] = {}
    filed: list[tuple[int, float, list]] = []
    acted: dict[int, list[float]] = {}  # complaint id -> hours after filing of each update made
    for _, kind, n, k in events:
        days_ago, text, area, actions = REPORTS[n]
        if kind == "file":
            started = time.perf_counter()
            r = client.post("/api/complaints", data={"text": text, "area": area})
            r.raise_for_status()
            c = r.json()
            ids[n] = c["id"]
            print(f"#{c['id']:<3} {c['status']:<12} {c['category'] or '-':<12} {c['urgency'] or '-':<9}"
                  f" dup={c['duplicate_of'] or '-':<4} {time.perf_counter() - started:4.0f}s  {text[:50]}", flush=True)
            if actions and c["status"] != "open":
                print(f"      (agent chose '{c['status']}', so its officer actions are skipped)")
            filed.append((c["id"], days_ago, []))
            continue
        cid = ids[n]
        c = client.get(f"/api/complaints/{cid}").json()
        if c["status"] not in ("open", "in_progress"):
            continue
        status, note, hours = actions[k]
        token = tokens.get(c["category"]) or tokens["all"]
        r = client.post(f"/api/officer/complaints/{cid}/status", json={"status": status, "note": note},
                        headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        acted.setdefault(cid, []).append(hours)
        print(f"  #{cid} -> {status:<11} [{r.json()['written_by']}] {r.json()['message_hi'][:70]}", flush=True)

    # Spread the history over two weeks: reports and their updates keep their real order.
    now = datetime.now(timezone.utc)
    db = sqlite3.connect(settings.data_dir / "awaaz.db")
    with db:
        for cid, days_ago, _ in filed:
            created = now - timedelta(days=days_ago)
            db.execute("UPDATE complaints SET created_at = ? WHERE id = ?", (created.isoformat(timespec="seconds"), cid))
            rows = db.execute("SELECT id FROM updates WHERE complaint_id = ? ORDER BY id", (cid,)).fetchall()
            for (update_id,), hours in zip(rows, acted.get(cid, [])):
                at = min(created + timedelta(hours=hours), now)
                db.execute("UPDATE updates SET created_at = ? WHERE id = ?", (at.isoformat(timespec="seconds"), update_id))
    db.close()
    print(f"done: {len(filed)} reports, spend today ${client.get('/api/health').json()['spent_today_usd']}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
