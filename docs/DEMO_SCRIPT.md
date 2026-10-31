# Awaaz — 3-minute demo video script

Narration is in plain English for the judges; the app on screen stays in Hindi, which is the point.
Speak slowly (about 130 words a minute). Record the voice in a quiet room, phone close to the mouth;
record the screen separately and lay the voice over it. Total narration: about 390 words.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:10 | Title card: "Awaaz — civic complaints in your own voice" | Everything in this repository was built during the hackathon week, from October 27. I had sketched the idea before the event, but none of that code is in this project. |
| 0:10–0:30 | Photo of a Supaul street with potholes (your own photo) | I live in Supaul, in Bihar. When a road breaks or the tap runs dry here, most people never complain. The forms are in English, the offices are far away, and nobody knows which department owns the problem. Awaaz lets anyone just say it. |
| 0:30–1:05 | Phone: citizen page. Tap the mic, say a complaint in Hindi, transcript appears. Add the pothole photo. Tap "शिकायत भेजें". | I speak in Hindi. The browser records it as a WAV file, and Meta's Voice Transcribe turns it into text. I add a photo and send it. If I had typed my phone number, it would be hidden before any person or model sees it. |
| 1:05–1:35 | Result card: department, urgency, SAM mask over the potholes, "AI ने क्या-क्या जाँचा" opened | A Muse Spark agent takes over. It searches for the same problem nearby, checks the photo with SAM 3.1, and decides the department and the urgency. Here you can see what SAM found, drawn over my photo. And this is the important part: the agent's answer is checked in code. If it claims a duplicate the search never returned, or says the photo shows a pothole when SAM found none, the answer is sent back and the agent has to fix it. |
| 1:35–1:55 | File the same problem again in other words → "पहले से दर्ज शिकायत से जोड़ी गई", "2 लोगों ने यही बताया" | When someone else reports the same pothole, it is not a new ticket. It is merged, and the complaint gets more weight. |
| 1:55–2:30 | Officer dashboard: tiles, hotspots, queue with critical items on top; open one item, its trace and Hindi letter | This is the officer's side. The queue is sorted by danger first, then by how many people reported it. Hotspots show where the same problems keep coming back. Every complaint comes with a formal letter in Hindi and the reasons behind the agent's decision. |
| 2:30–2:50 | Officer types "JE ne site dekh li, kal se kaam" → clicks "काम शुरू" → the Hindi message appears | The officer writes a short note, in any language. Muse Spark Open, Meta's open-weights model running on Baseten, turns it into a simple Hindi update for the citizen. It may not add any number or promise the officer did not make. |
| 2:50–3:00 | Phone: tracking page with the new update | And the citizen sees it on their tracking page. Awaaz: so that every voice reaches the right desk. |

## Before recording

- Use the hosted demo, logged in as `demo.officer`, so the dashboard has two weeks of history.
- File the "live" complaint just before recording, so it appears at the top of the queue.
- Have one real photo from Supaul ready on the phone (pothole, garbage pile, broken street light or a full drain).
- Close other tabs; zoom the browser to 110–125 % so the Hindi text is readable in the video.
- After recording, check the video is under 3:00 and the first sentence is the "built this week" line.
