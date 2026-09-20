// ---------------------------------------------------------------------------
// The pilot's microphone: one spoken request at a time, through the browser's
// own speech recognition (Chrome and Edge; it needs the mic permission and a
// network connection, since the browser does the recognising remotely).
//
// It is push-to-talk on purpose. An always-open mic hears the jets, the
// explosions and JARVIS himself, and answers them.
// ---------------------------------------------------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * @param handlers {
 *   onState(listening: boolean),
 *   onInterim(text),            words so far, while the pilot is still talking
 *   onFinal(text),              the finished request
 *   onError(reason),            'denied' | 'silence' | 'unavailable'
 * }
 */
export function createListener({ onState, onInterim, onFinal, onError }) {
  if (!Recognition) {
    return { supported: false, listening: () => false, start: () => onError?.('unavailable'), stop() {} };
  }

  let recognition = null;

  function start() {
    if (recognition) return;
    const r = new Recognition();
    r.lang = 'en-US';
    r.continuous = false; // one utterance; it ends itself on the pause after it
    r.interimResults = true;
    r.maxAlternatives = 1;

    let heard = '';
    let failed = false;
    r.onresult = (e) => {
      let text = '';
      for (const result of e.results) text += result[0].transcript;
      heard = text.trim();
      if (!e.results[e.results.length - 1].isFinal) onInterim?.(heard);
    };
    r.onerror = (e) => {
      failed = true;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') onError?.('denied');
      else if (e.error === 'no-speech' || e.error === 'aborted') onError?.('silence');
      else onError?.('unavailable');
    };
    r.onend = () => {
      recognition = null;
      onState?.(false);
      if (failed) return;
      if (heard) onFinal?.(heard);
      else onError?.('silence');
    };

    recognition = r;
    try {
      r.start();
      onState?.(true);
    } catch {
      recognition = null;
      onError?.('unavailable');
    }
  }

  return {
    supported: true,
    listening: () => Boolean(recognition),
    start,
    /** Stop listening and take what was heard so far. */
    stop: () => recognition?.stop(),
  };
}
