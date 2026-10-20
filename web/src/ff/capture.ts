/**
 * Capture a question from the physical world: splitting and matching.
 *
 * This module is pure (no DOM, no XR, no OCR engine) so it is tested in node. The
 * pipeline it serves:
 *
 *   photo of a book / laptop screen
 *     -> OCR (ff/ocr.ts, Tesseract running locally, nothing uploaded)
 *     -> splitQuestions()   one page becomes a list of separate questions
 *     -> the learner picks one (click on desktop; NEXT/PLAY on the bench in XR)
 *     -> "Solve this question?" (an explicit confirm, never automatic)
 *     -> matchCorpus()      if it is one of our verified golden problems, load that
 *        (kernel-checked, works with no AI at all)
 *        ...otherwise the AI boundary (extract.ts) proposes a Scene and the kernel
 *        validator accepts or rejects it. Capture never computes physics.
 *
 * A note on the Quest camera: WebXR does not give web apps the passthrough camera
 * feed, so a web page cannot literally read the book through the lenses. Capture
 * happens on the companion screen (laptop/phone camera or an uploaded photo —
 * including a screenshot taken in the headset and shared to the companion), and
 * everything after the capture — picking, confirming, building — happens in the
 * glasses. The boundary is stated in the UI rather than faked.
 */

/** One detected question on a captured page. */
export interface CapturedQuestion {
  /** "Q3" / "7" when the page numbered it, else "•". */
  marker: string;
  text: string;
}

const MARKER =
  /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.)\]:]|^\s*\((\d{1,3})\)|^\s*(?:Q(?:uestion)?)\s*(\d{1,3})\b/i;

/**
 * Split OCR text into individual questions by their numbering.
 *
 * Conservative: only a run of >= 2 markers in increasing order is trusted; anything
 * else returns the whole page as one question. OCR noise (a "1." inside a value)
 * must never shred a question into fragments.
 */
export function splitQuestions(raw: string): CapturedQuestion[] {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const marks: Array<{ line: number; num: number; marker: string }> = [];
  lines.forEach((line, i) => {
    const m = MARKER.exec(line);
    if (m) {
      const num = Number(m[1] ?? m[2] ?? m[3]);
      if (Number.isFinite(num)) marks.push({ line: i, num, marker: `Q${num}` });
    }
  });
  const increasing = marks.filter((m, i) => i === 0 || m.num > marks[i - 1]!.num);
  if (increasing.length < 2) return [{ marker: '•', text }];
  const out: CapturedQuestion[] = [];
  increasing.forEach((mark, i) => {
    const end = i + 1 < increasing.length ? increasing[i + 1]!.line : lines.length;
    const body = lines.slice(mark.line, end).join('\n').trim();
    if (body.length >= 12) out.push({ marker: mark.marker, text: body });
  });
  return out.length > 0 ? out : [{ marker: '•', text }];
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'is', 'are', 'what', 'when', 'how', 'much', 'many', 'in',
  'on', 'at', 'to', 'and', 'or', 'with', 'from', 'by', 'it', 'its', 'if', 'than',
  'then', 'through', 'across', 'between', 'into', 'find', 'calculate', 'determine',
]);

const tokens = (s: string): Set<string> => {
  const out = new Set<string>();
  for (const t of s.toLowerCase().replace(/[^a-z0-9.Ωµ]+/g, ' ').split(/\s+/)) {
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
    // Numbers with units are the strongest signal a textbook question carries.
    if (/^\d/.test(t)) out.add(t);
  }
  return out;
};

export interface CorpusCandidate {
  id: string;
  haystack: string;
}

/**
 * Score a captured question against the golden corpus (title + full statement).
 * Returns the best id at or above `threshold`, else null. Token overlap only —
 * a capture that matches a verified problem needs no AI and no trust; anything
 * below threshold goes to the AI boundary or the Free bench, said honestly.
 */
export function matchCorpus(
  question: string,
  corpus: readonly CorpusCandidate[],
  threshold = 0.34,
): { id: string; score: number } | null {
  const q = tokens(question);
  if (q.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const cand of corpus) {
    const h = tokens(cand.haystack);
    let hit = 0;
    for (const t of q) if (h.has(t)) hit += 1;
    const score = hit / q.size;
    if (score >= threshold && (best === null || score > best.score)) {
      best = { id: cand.id, score };
    }
  }
  return best;
}
