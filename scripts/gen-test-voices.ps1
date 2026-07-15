# Generates TTS utterance WAVs (16 kHz mono s16le) for the diarization
# accuracy harness. Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/gen-test-voices.ps1 <outDir>
# Produces david_NN.wav / zira_NN.wav utterances plus david_enroll_N.wav /
# zira_enroll_N.wav held-out enrollment clips. Pitch-shifted "similar voice"
# variants are made separately with ffmpeg by the harness generator.
param([Parameter(Mandatory=$true)][string]$OutDir)

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

# Varied-length utterances: short interjections through long monologue pieces
$utterances = @(
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
  "We had a near miss reported on Monday near the loading bay, so I want to walk through what happened, what the immediate causes were, and what we are changing so it does not happen again."
)

$enrollTexts = @(
  "Hello, my name is being enrolled for voice identification. I am reading this passage naturally, at my normal pace, the way I would speak in a real meeting with colleagues.",
  "When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colours.",
  "Yesterday I reviewed the site paperwork, checked the training records, and called two suppliers about the delivery schedule for next month. Everything looks on track so far."
)

$voices = @{ david = "Microsoft David Desktop"; zira = "Microsoft Zira Desktop" }
$rates  = @(0, 1, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0)

foreach ($key in $voices.Keys) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voices[$key])
  for ($i = 0; $i -lt $utterances.Count; $i++) {
    $synth.Rate = $rates[$i % $rates.Count]
    $file = Join-Path $OutDir ("{0}_{1:d2}.wav" -f $key, $i)
    $synth.SetOutputToWaveFile($file, $fmt)
    $synth.Speak($utterances[$i])
    $synth.SetOutputToNull()
  }
  for ($i = 0; $i -lt $enrollTexts.Count; $i++) {
    $synth.Rate = 0
    $file = Join-Path $OutDir ("{0}_enroll_{1}.wav" -f $key, $i)
    $synth.SetOutputToWaveFile($file, $fmt)
    $synth.Speak($enrollTexts[$i])
    $synth.SetOutputToNull()
  }
  $synth.Dispose()
}
Write-Output ("Generated " + (Get-ChildItem $OutDir -Filter *.wav).Count + " wav files in " + $OutDir)
