// One-off codemod: wrap user-visible English strings in tr(…), using the
// TypeScript parser (no regex guessing). Prints the keys it created.
//   node i18n-wrap.mjs <src dir> <file> [<file> …]
import { createRequire } from "node:module";
const ts = createRequire(process.cwd() + "/")("typescript");
import fs from "node:fs";
import path from "node:path";

const [, , srcDir, ...files] = process.argv;
const ATTRS = new Set(["title", "placeholder", "alt", "noneLabel", "originalLabel", "label"]);
const CALLS = new Set(["notify", "setError", "setProgress", "Error"]);
const hasWords = (s) => /[A-Za-z]{2,}/.test(s);
const keys = new Set();

function jsxCollapse(text) {
  // JSX semantics: lines trimmed, blank lines dropped, joined with a space.
  const lines = text.split(/\r?\n/);
  if (lines.length === 1) return text;
  return lines
    .map((l, i) => (i === 0 ? l.replace(/\s+$/, "") : i === lines.length - 1 ? l.replace(/^\s+/, "") : l.trim()))
    .filter((l) => l.length)
    .join(" ");
}

// tr("…{0}…", a, b) from a template literal.
function fromTemplate(node, src) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { key: node.text, args: [] };
  let key = node.head.text;
  const args = [];
  node.templateSpans.forEach((sp, i) => {
    key += `{${i}}` + sp.literal.text;
    args.push(sp.expression.getText(src));
  });
  return { key, args };
}

const call = (key, args) => {
  keys.add(key);
  return `tr(${JSON.stringify(key)}${args.map((a) => `, ${a}`).join("")})`;
};

for (const rel of files) {
  const file = path.join(srcDir, rel);
  const text = fs.readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = []; // [start, end, replacement]

  function visit(n) {
    // <p>Some text</p>
    if (ts.isJsxText(n)) {
      const raw = n.getFullText(src);
      if (hasWords(raw)) {
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const core = raw.slice(lead.length, raw.length - trail.length);
        const key = jsxCollapse(core).replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
        // Keep a meaningful space next to an expression on the same line.
        const keepLead = lead && !lead.includes("\n") ? lead : lead;
        edits.push([n.getFullStart(), n.getEnd(), `${keepLead}{${call(key, [])}}${trail}`]);
      }
      return;
    }
    // title="…" placeholder="…"
    if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && ATTRS.has(n.name.getText(src)) && hasWords(n.initializer.text)) {
      edits.push([n.initializer.getStart(src), n.initializer.getEnd(), `{${call(n.initializer.text, [])}}`]);
      return;
    }
    // {cond ? "Yes" : "No"} / {`Page ${n}`} directly in JSX children
    if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
      const visitInner = (e) => {
        if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && hasWords(e.text)) {
          edits.push([e.getStart(src), e.getEnd(), call(e.text, [])]);
          return;
        }
        if (ts.isTemplateExpression(e) && hasWords(e.head.text + e.templateSpans.map((s) => s.literal.text).join(""))) {
          const { key, args } = fromTemplate(e, src);
          edits.push([e.getStart(src), e.getEnd(), call(key, args)]);
          return;
        }
        if (ts.isConditionalExpression(e)) {
          visitInner(e.whenTrue);
          visitInner(e.whenFalse);
          return;
        }
        if (ts.isParenthesizedExpression(e)) return visitInner(e.expression);
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return visitInner(e.right);
      };
      visitInner(n.expression);
    }
    // notify("…") store.notify(`…${x}`) setError("…") new Error("…")
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.length) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (CALLS.has(name)) {
        const a = n.arguments[0];
        const wrap = (e) => {
          if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && hasWords(e.text)) edits.push([e.getStart(src), e.getEnd(), call(e.text, [])]);
          else if (ts.isTemplateExpression(e)) {
            const { key, args } = fromTemplate(e, src);
            if (hasWords(key)) edits.push([e.getStart(src), e.getEnd(), call(key, args)]);
          } else if (ts.isConditionalExpression(e)) {
            wrap(e.whenTrue);
            wrap(e.whenFalse);
          }
        };
        wrap(a);
      }
    }
    // ({ status: `…`, page })
    if (ts.isPropertyAssignment(n) && n.name.getText(src) === "status") {
      const e = n.initializer;
      if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && hasWords(e.text)) edits.push([e.getStart(src), e.getEnd(), call(e.text, [])]);
      else if (ts.isTemplateExpression(e)) {
        const { key, args } = fromTemplate(e, src);
        edits.push([e.getStart(src), e.getEnd(), call(key, args)]);
      }
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(src);
  if (!edits.length) continue;
  // Apply from the end; skip edits nested inside an earlier (outer) one.
  edits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let out = text;
  let lastStart = Infinity;
  for (const [s, e, r] of edits) {
    if (e > lastStart) continue;
    out = out.slice(0, s) + r + out.slice(e);
    lastStart = s;
  }
  // import { tr }
  if (!/import \{ tr \} from/.test(out)) {
    const relI18n = path.relative(path.dirname(file), path.join(srcDir, "i18n")).replace(/\\/g, "/");
    const imp = `import { tr } from "${relI18n.startsWith(".") ? relI18n : "./" + relI18n}";\n`;
    const lastImport = [...out.matchAll(/^import .*?;\s*$/gms)].pop();
    const at = lastImport ? lastImport.index + lastImport[0].length : 0;
    out = out.slice(0, at) + (at ? "\n" : "") + imp + out.slice(at);
  }
  fs.writeFileSync(file, out);
  console.error(`${rel}: ${edits.length} strings`);
}
console.log(JSON.stringify([...keys], null, 1));
