/**
 * The two cards that float over the bench, drawn as pure functions of a 2D canvas.
 *
 *   Trust card  an instrument readout: dark slate, phosphor teal, the verified number in amber
 *               mono. It always says where a number came from and that no AI is in the solver.
 *   Guide card  a lab worksheet: warm paper, ink text, a step pill and progress dots. It is the
 *               card a student reads while their hands are busy.
 *
 * No emoji: the 3D text font cannot draw them (they render as empty boxes), so every string is
 * stripped of pictographs on the way in. No DOM and no ECS here, which keeps the look testable.
 */

import { LAB_PALETTE as P, stripPictographs } from './lab.js';

export type GuideState = 'idle' | 'task' | 'observe' | 'done';

const SANS = 'system-ui,"Segoe UI",Roboto,"Helvetica Neue",sans-serif';
const MONO = 'ui-monospace,Menlo,Consolas,"Liberation Mono",monospace';

/** Word-wrap `text` and return the y below the last line. Stops at `maxLines`, adding an ellipsis. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): number {
  const words = stripPictographs(text).split(/\s+/).filter(Boolean);
  let line = '';
  let drawn = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      const last = drawn + 1 >= maxLines && i < words.length;
      ctx.fillText(last ? `${line}\u2026` : line, x, y);
      y += lineHeight;
      drawn += 1;
      if (last) return y;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, fill: string, ink: string): number {
  ctx.font = `700 26px ${SANS}`;
  const padX = 18;
  const w = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 40, 20);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + 21);
  ctx.textBaseline = 'alphabetic';
  return x + w;
}

// --------------------------------------------------------------------------- trust card

export function drawTrustCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  title: string,
  lines: readonly string[],
  bundle: string | null,
): void {
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#0b161b');
  bg.addColorStop(1, '#10262d');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 34);
  ctx.fill();
  ctx.strokeStyle = 'rgba(45,212,191,0.45)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // faint instrument grid
  ctx.strokeStyle = 'rgba(45,212,191,0.05)';
  ctx.lineWidth = 1;
  for (let x = 48; x < w - 20; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 24);
    ctx.lineTo(x, h - 24);
    ctx.stroke();
  }

  // header: a drawn check in a ring, then the caption
  ctx.strokeStyle = P.teal;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(62, 62, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(51, 63);
  ctx.lineTo(59, 72);
  ctx.lineTo(75, 52);
  ctx.stroke();
  ctx.fillStyle = P.teal;
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText('VERIFIED', 100, 60);
  ctx.fillStyle = P.mute;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText('dimensions checked', 244, 60);

  // title
  ctx.fillStyle = '#f2fbf9';
  ctx.font = `700 46px ${SANS}`;
  let y = wrapText(ctx, title, 44, 132, w - 88, 52, 2);

  // body: the value line is promoted to a big mono readout
  y += 6;
  for (const raw of lines.slice(0, 8)) {
    const text = stripPictographs(raw);
    if (!text) continue;
    if (/^(value|answer)\s*:/i.test(text)) {
      ctx.fillStyle = P.amber;
      ctx.font = `700 52px ${MONO}`;
      y = wrapText(ctx, text.replace(/^(value|answer)\s*:\s*/i, ''), 44, y + 40, w - 88, 56, 1);
      continue;
    }
    ctx.fillStyle = '#c3e4de';
    ctx.font = `400 28px ${SANS}`;
    y = wrapText(ctx, text, 44, y + 30, w - 88, 36, 2);
    if (y > h - 92) break;
  }

  // footer
  ctx.fillStyle = 'rgba(125,211,200,0.8)';
  ctx.font = `400 21px ${MONO}`;
  ctx.fillText(
    bundle ? `bundle ${bundle} \u00B7 kernel-verified \u00B7 no AI in the solver` : 'kernel-verified \u00B7 no AI in the solver',
    44,
    h - 32,
  );
}

// --------------------------------------------------------------------------- guide card

const STATE_STYLE: Record<GuideState, { label: string; accent: string }> = {
  idle: { label: 'LAB GUIDE', accent: '#8a9aa0' },
  task: { label: 'YOUR TURN', accent: '#e08a00' },
  observe: { label: 'WATCH', accent: '#0f9d8a' },
  done: { label: 'DONE', accent: '#16a34a' },
};

export function drawGuideCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  title: string,
  lines: readonly string[],
  state: GuideState,
  progress: { index: number; total: number } | null,
): void {
  const style = STATE_STYLE[state];
  ctx.clearRect(0, 0, w, h);

  // paper, with a soft edge and an accent bar down the left, like a coloured tab
  const paper = ctx.createLinearGradient(0, 0, 0, h);
  paper.addColorStop(0, '#f8f3e8');
  paper.addColorStop(1, '#eee6d4');
  ctx.fillStyle = paper;
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 30);
  ctx.fill();
  ctx.strokeStyle = P.paperEdge;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = style.accent;
  ctx.beginPath();
  ctx.roundRect(4, 4, 22, h - 8, [30, 0, 0, 30]);
  ctx.fill();

  // header row: state pill, then the step counter
  const cleanTitle = stripPictographs(title);
  const match = /^(?:\u2713\s*)?Step\s+(\d+)\s*\/\s*(\d+)\s*(?:[\u2014-]\s*(.*))?$/i.exec(cleanTitle);
  let x = pill(ctx, 52, 34, style.label, style.accent, '#ffffff') + 14;
  const heading = match ? (match[3] ?? '') : cleanTitle;
  if (match) {
    ctx.fillStyle = P.ink;
    ctx.font = `600 28px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(`STEP ${match[1]} / ${match[2]}`, x, 55);
    ctx.textBaseline = 'alphabetic';
  }

  // progress dots, right-aligned
  if (progress && progress.total > 0) {
    const gap = Math.min(30, (w - 520) / Math.max(1, progress.total));
    for (let i = 0; i < progress.total; i += 1) {
      ctx.beginPath();
      ctx.arc(w - 48 - (progress.total - 1 - i) * gap, 54, 9, 0, Math.PI * 2);
      ctx.fillStyle = i < progress.index ? '#16a34a' : i === progress.index ? '#e08a00' : '#cfc7b4';
      ctx.fill();
    }
  }

  // title and body in ink
  ctx.fillStyle = P.ink;
  ctx.font = `700 52px ${SANS}`;
  let y = wrapText(ctx, heading || cleanTitle, 52, 138, w - 104, 58, 2);
  ctx.font = `400 33px ${SANS}`;
  ctx.fillStyle = '#34464e';
  for (const line of lines) {
    y = wrapText(ctx, line, 52, y + 18, w - 104, 44, 4);
    if (y > h - 72) break;
  }

  if (state === 'task') {
    ctx.fillStyle = style.accent;
    ctx.font = `600 27px ${SANS}`;
    ctx.fillText('Use your hands. The bench is watching.', 52, h - 30);
  }
}
