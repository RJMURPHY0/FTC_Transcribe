"""Generate a bank of genuinely distinct British/Irish voices for the
diarisation benchmark.

Windows SAPI only exposes two usable voices, and pitch-shifting one voice does
NOT create a second person -- TitaNet correctly merges those, so scoring it as
an error would make the benchmark lie. This uses Edge neural voices instead:
seven real, distinct speakers with UK/IE accents matching actual users, and
including two GB males plus an IE male so the hard "similar voices in one room"
case is represented honestly.

    python scripts/gen-voices-edge.py <outDir>

Produces <id>_NN.wav utterances and <id>_enroll_N.wav held-out enrolment clips,
all 16 kHz mono s16le, matching the layout scripts/diar-bench.ts expects.
Only generic meeting phrases are sent to the TTS service; no real meeting data.
"""
import asyncio
import os
import subprocess
import sys

import edge_tts

VOICES = {
    "gbm1": "en-GB-RyanNeural",
    "gbf1": "en-GB-SoniaNeural",
    "gbm2": "en-GB-ThomasNeural",
    "gbf2": "en-GB-LibbyNeural",
    "iem1": "en-IE-ConnorNeural",
    "gbf3": "en-GB-MaisieNeural",
    "ief1": "en-IE-EmilyNeural",
}

UTTERANCES = [
    "Yeah, I agree with that.",
    "Hold on, can you repeat the last part?",
    "Right, so the first item on the agenda is the quarterly safety review, and I want to make sure everyone has read the incident report from last Tuesday before we go through the findings in detail.",
    "The scaffolding inspection is booked for Thursday morning.",
    "I think we should push the deadline back a week, because the supplier confirmed the materials will not arrive until Friday and there is no point rushing the installation over the weekend.",
    "No, that was the other site.",
    "Let me pull up the numbers. So for June we completed forty two inductions, sixteen toolbox talks, and three audits, which puts us slightly ahead of where we were this time last year.",
    "Can everyone see my screen?",
    "The new starters need their inductions booked before the end of the month, and I would like the paperwork done by Wednesday so we have time to chase any missing certificates.",
    "That works for me.",
    "Before we wrap up, does anyone have anything else they would like to raise about the training schedule or the site access arrangements for next week?",
    "I will send the updated schedule to everyone by email this afternoon, and if anything changes on the client side I will flag it in the group chat straight away.",
    "Okay, perfect.",
    "We had a near miss reported on Monday near the loading bay, so I want to walk through what happened, what the immediate causes were, and what we are changing so it does not happen again.",
]

ENROLL = [
    "Hello, my name is being enrolled for voice identification. I am reading this passage naturally, at my normal pace, the way I would speak in a real meeting with colleagues.",
    "When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colours.",
    "Yesterday I reviewed the site paperwork, checked the training records, and called two suppliers about the delivery schedule for next month. Everything looks on track so far.",
]

# Slight rate variation so the same sentence is not prosodically identical
# across speakers -- otherwise the embedder can key on timing rather than voice.
RATES = ["+0%", "+6%", "-6%", "+0%", "+8%", "+0%", "-8%", "+0%", "+5%", "+0%", "-5%", "+0%", "+7%", "+0%"]


def ffmpeg_bin() -> str:
    local = os.path.join("node_modules", "ffmpeg-static", "ffmpeg.exe")
    return local if os.path.exists(local) else "ffmpeg"


async def render(voice: str, text: str, rate: str, dest_wav: str, sem: asyncio.Semaphore) -> None:
    if os.path.exists(dest_wav) and os.path.getsize(dest_wav) > 2000:
        return
    tmp_mp3 = dest_wav + ".mp3"
    async with sem:
        for attempt in range(3):
            try:
                await edge_tts.Communicate(text, voice, rate=rate).save(tmp_mp3)
                break
            except Exception as exc:  # transient service errors
                if attempt == 2:
                    raise
                print(f"  retry {voice}: {exc}")
                await asyncio.sleep(2 * (attempt + 1))
    subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-nostdin",
         "-i", tmp_mp3, "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
         "-y", dest_wav],
        check=True,
    )
    os.remove(tmp_mp3)


async def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python scripts/gen-voices-edge.py <outDir>")
        sys.exit(1)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    sem = asyncio.Semaphore(4)

    tasks = []
    for vid, voice in VOICES.items():
        for i, text in enumerate(UTTERANCES):
            tasks.append(render(voice, text, RATES[i % len(RATES)],
                                os.path.join(out, f"{vid}_{i:02d}.wav"), sem))
        for i, text in enumerate(ENROLL):
            tasks.append(render(voice, text, "+0%",
                                os.path.join(out, f"{vid}_enroll_{i}.wav"), sem))

    print(f"rendering {len(tasks)} clips across {len(VOICES)} voices...")
    await asyncio.gather(*tasks)
    n = len([f for f in os.listdir(out) if f.endswith(".wav")])
    print(f"done: {n} wav files in {out}")
    print("voices: " + ", ".join(f"{k}={v}" for k, v in VOICES.items()))


if __name__ == "__main__":
    asyncio.run(main())
