# Awaaz — 3-minute demo video script

Narration is in plain English for the judges; the app on screen stays in Hindi, which is the point.
Speak slowly (about 130 words a minute) in a quiet room, phone close to the mouth. Record the voice as one
file; the screen shots are made from the real app and laid under it (`meta-hackathon/video`).
Total narration: about 350 words, 2:50 at an easy pace, leaving 10 seconds to spare.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:14 | Title card: "Awaaz — civic complaints in your own voice" | Everything in this repository was built during the hackathon week, from October 27. I had sketched the idea before the event, but none of that code is in this project. |
| 0:14–0:32 | Three real photos from Forbesganj, Bihar, 30 October: a choked drain, garbage by a wall, mud at Subhash Chowk | I took these photos in Forbesganj, in Bihar, last week. Problems like these stay for months, because most people never complain. The forms are in English, the offices are far, and nobody knows which department owns the problem. |
| 0:32–0:50 | Home page: the turning Ashoka chakra, the live numbers, the red emergency strip, then the town picker set to Forbesganj | Awaaz is a public dashboard first. Anyone can see what has been reported in their town, what is an emergency, how many people reported the same thing, and what has been fixed. Everything is public, except the citizen's personal data. |
| 0:50–1:16 | Tap "शिकायत करें": the form sheet. Tap the mic, speak in Hindi, the recorder turns red with a timer, then green: "लिख लिया". Tap "मेरी सटीक जगह जोड़ें": the radar, accuracy improving to ±15 m. Add the photo. The information stars fill up. Send. | To complain, I just speak in Hindi. Meta's Voice Transcribe writes it down. One tap adds my exact GPS spot, so the officer can reach the very place. A photo and a mobile number are optional; they only make the report stronger. My number is never shown to anyone, not even the officer. |
| 1:16–1:47 | Ticket popup "#30, joined to #27"; then the result: SAM's orange mask over the garbage, "AI ने क्या-क्या जाँचा" opened | A Muse Spark agent takes over. It found the same garbage pile already reported, so my report was joined to it, and that complaint now has two people behind it. SAM 3.1 checked the photo. And every answer of the agent is checked in code: if it claims a duplicate the search never returned, or a photo SAM does not support, the answer is sent back. |
| 1:47–2:03 | Tracking page: the four-step progress, "AI का फ़ैसला" with its reason, every step's time, the red "2 days without reply" warning; "मेरी शिकायतें" by mobile | The citizen tracks it in the open: which department, why, and how many hours each step took. If a department stays silent for two days, the page says so, for everyone to see. |
| 2:03–2:32 | Officer dashboard: KPIs, hover one day on the daily chart (new, fixed, open at day end), department ranking; open the garbage complaint, its map pin, type "Safai karmi bheje", the "📷 काम की फ़ोटो जोड़ें" button, tap "काम शुरू" | Officers see danger first, then what most people reported, with the exact spot on a map. A daily chart shows what came in, what was fixed, and what is still open. The officer writes a short note in Hinglish. Muse Spark Open, Meta's open-weights model on Baseten, turns it into a polite Hindi update, and may not add any promise the officer did not make. |
| 2:32–2:41 | The real cleanup photo from Pipra, Supaul (18 Jan 2026), then the tracking page's work-photo slot | When the work is done, the officer adds a photo, like this real cleanup in Pipra, and the town sees the before and the after. |
| 2:41–2:50 | End card | Awaaz: so that every voice reaches the right desk, and everyone can see what happened next. |

## Before recording

- Use the hosted demo; open it once a minute before, so the free server is awake.
- The officer step uses the demo login `demo.officer` (password set in Render).
- Keep the Forbesganj photos with the GPS strip cut off (`meta-hackathon/real-photos`, not the `original/`
  ones). The drain and garbage photos work best: SAM finds them.
- After recording, check the video is under 3:00 and the first sentence is the "built this week" line.
