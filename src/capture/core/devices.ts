/** Parses `ffmpeg -list_devices true -f dshow -i dummy` output into microphone names. */
export function parseDshowAudioDevices(stderr: string): string[] {
  const names: string[] = [];
  let section: "video" | "audio" | null = null;
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]*\]\s*/, "");
    // Older ffmpeg prints section headers.
    if (/DirectShow video devices/i.test(line)) section = "video";
    else if (/DirectShow audio devices/i.test(line)) section = "audio";
    if (/Alternative name/i.test(line)) continue;
    const m = /^"(.+)"\s*(\((audio|video|none)[^)]*\))?\s*$/.exec(line.trim());
    if (!m) continue;
    // Newer ffmpeg tags each device: "Name" (audio)
    const kind = m[3] ?? section;
    if (kind === "audio" && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}
