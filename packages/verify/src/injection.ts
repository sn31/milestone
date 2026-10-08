/** Cheap pre-pass: text that addresses the reviewer or asks for approval is flagged before the model sees it. */
const PATTERNS = [
  /\b(approve|release|pass)\b.{0,40}\b(this|the)\b.{0,20}\b(milestone|pr|pull request|delivery|payment)\b/i,
  /\b(ignore|disregard|forget)\b.{0,40}\b(instructions|criteria|rules|checks?)\b/i,
  /\b(reviewer|verifier|agent|assistant|ai|claude|model)\b.{0,10}[:,]/i,
  /\byou (must|should|are required to)\b.{0,40}\b(approve|release|pass|mark)\b/i,
  /\ball (criteria|tests?) (pass|passed|are met)\b/i,
  /<\/?(system|instructions?|evidence)\b[^>]*>/i,
];

export function detectInjection(texts: Array<{ source: string; text: string }>): { suspected: boolean; hits: Array<{ source: string; match: string }> } {
  const hits: Array<{ source: string; match: string }> = [];
  for (const t of texts) {
    for (const re of PATTERNS) {
      const m = re.exec(t.text);
      if (m) hits.push({ source: t.source, match: m[0].slice(0, 120) });
    }
  }
  return { suspected: hits.length > 0, hits };
}
