// ---------------------------------------------------------------------------
// A JARVIS line is shown in the HUD ticker and spoken (audio/voice.js). Every
// distinct sentence he speaks is a recording that has to be bought once, so a
// figure that changes from run to run — a course time, an exact percentage —
// must not reach the voice, or every occurrence of the line is a new purchase
// that is never played again.
//
// Such a figure goes in {braces}: it is shown, and never spoken.
//
//   `Course complete{ in ${time}}. A new record.`
//     ticker:  Course complete in 1:23.4. A new record.
//     voice:   Course complete. A new record.
// ---------------------------------------------------------------------------

/** The line as the ticker shows it: everything, without the braces. */
export function shownLine(line) {
  return line.replace(/[{}]/g, '');
}

/** The line as JARVIS says it: without anything in braces. */
export function spokenLine(line) {
  return line
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}
