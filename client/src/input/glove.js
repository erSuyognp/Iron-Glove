let onGloveData = () => {};

export function setGloveHandler(fn) {
  onGloveData = fn;
}

export async function connectGlove() {
  if (!navigator.serial) {
    alert('Web Serial requires Chrome. Switch browsers to use the glove.');
    return false;
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value);
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        try {
          const parts = line.trim().split(',').map(Number);
          if (parts.length >= 2 && Number.isFinite(parts[0])) {
            // pitch, roll, ax, ay, az
            onGloveData({
              pitch: parts[0],
              roll:  parts[1],
              ax:    parts[2] ?? 0,
              ay:    parts[3] ?? 0,
              az:    parts[4] ?? 0,
              fist:  parts[2] != null && Math.abs(parts[2]) > 1.5,
            });
          }
        } catch {}
      }
    }
  })();

  return true;
}
