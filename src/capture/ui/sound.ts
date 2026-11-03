/**
 * A short synthesised camera-shutter click, played as feedback when a
 * screenshot is taken. Generated with the Web Audio API rather than a
 * bundled file, so there's nothing to license or ship.
 */
let ctx: AudioContext | null = null;

function click(at: number, freq: number, durationMs: number, gain: number) {
  const audio = ctx!;
  const osc = audio.createOscillator();
  const vol = audio.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  vol.gain.setValueAtTime(gain, at);
  vol.gain.exponentialRampToValueAtTime(0.0001, at + durationMs / 1000);
  osc.connect(vol).connect(audio.destination);
  osc.start(at);
  osc.stop(at + durationMs / 1000);
}

export function playShutterSound(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    click(now, 1400, 18, 0.22); // open
    click(now + 0.06, 900, 28, 0.16); // close
  } catch {
    // Audio is a nice-to-have; never let it break a capture.
  }
}
