// Collect translatable English strings from the app sources.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const ts = createRequire(process.cwd() + "/")("typescript");
const root = process.argv[2];
const keys = new Set();
const PROPS = new Set(["label", "tip", "menu", "title"]);
const ARRAYS = new Set(["STAMPS", "RIBBON_TABS"]);
const hasWords = (s) => /[A-Za-z]{2,}/.test(s);
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?)$/.test(f) && !f.endsWith(".d.ts") && f !== "icons.tsx" && f !== "i18n.ts") scan(p);
  }
}
function scan(file) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    // trn(n, "one", "other", …): the English plural is the key.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "trn" && n.arguments[2] && ts.isStringLiteral(n.arguments[2])) keys.add(n.arguments[2].text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "tr" && n.arguments[0] && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))) keys.add(n.arguments[0].text);
    if (ts.isPropertyAssignment(n) && PROPS.has(n.name.getText(src)) && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) && hasWords(n.initializer.text)) keys.add(n.initializer.text);
    if (ts.isVariableDeclaration(n) && n.name.getText(src) === "TOOL_HINT" && n.initializer && ts.isObjectLiteralExpression(n.initializer))
      n.initializer.properties.forEach((p) => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) && keys.add(p.initializer.text));
    if (ts.isVariableDeclaration(n) && ARRAYS.has(n.name.getText(src)) && n.initializer && ts.isArrayLiteralExpression(n.initializer))
      n.initializer.elements.forEach((e) => ts.isStringLiteral(e) && keys.add(e.text));
    ts.forEachChild(n, visit);
  };
  visit(src);
}
walk(root);
for (const extra of ["Black ink", "Blue ink", "Colour Scheme", "Ribbon Tab", "Export", "Window", " (coming soon)", "File", "Edit", "Pages", "Annotate", "Forms", "Security", "View", "Help"]) keys.add(extra);
const list = [...keys].filter((k) => hasWords(k)).sort();
fs.writeFileSync(process.argv[3], JSON.stringify(list, null, 1));
console.log(list.length, "strings,", list.join(" ").split(/\s+/).length, "words");
