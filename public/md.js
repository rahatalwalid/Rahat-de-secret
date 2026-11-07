// Small, safe Markdown renderer. All text is HTML-escaped first; only a fixed set of tags is ever emitted.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(src) {
  return src.split(/(`[^`\n]+`)/g).map((part, i) => {
    if (i % 2) return "<code>" + esc(part.slice(1, -1)) + "</code>";
    let s = esc(part);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"<]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }).join("");
}

export function md(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w+-]*)/);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of stream while still typing)
      out.push(`<div class="code"><div class="code-bar"><span>${esc(fence[1] || "code")}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code>${esc(code.join("\n"))}</code></pre></div>`);
      continue;
    }
    const hd = line.match(/^(#{1,4})\s+(.*)$/);
    if (hd) { out.push(`<h${hd[1].length + 2}>${inline(hd[2])}</h${hd[1].length + 2}>`); i++; continue; }
    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line), items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))) items.push(`<li>${inline(lines[i++].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))}</li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(inline(lines[i++].replace(/^>\s?/, "")));
      out.push(`<blockquote>${q.join("<br>")}</blockquote>`); continue;
    }
    if (!line.trim()) { i++; continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i])) p.push(inline(lines[i++]));
    out.push(`<p>${p.join("<br>")}</p>`);
  }
  return out.join("");
}
