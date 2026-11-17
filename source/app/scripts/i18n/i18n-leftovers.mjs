import { createRequire } from "node:module";
import fs from "node:fs";
const ts = createRequire(process.cwd() + "/")("typescript");
for (const file of process.argv.slice(2)) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    const isStr = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
    if (isStr) {
      const text = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => "{}" + s.literal.text).join("") : n.text;
      // A sentence-like string: starts uppercase, has a space and 2+ words.
      if (/^[A-Z][a-z]+[ ,][\s\S]*[a-z]{2,}/.test(text)) {
        let p = n.parent, inTr = false;
        while (p && !ts.isSourceFile(p)) {
          if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "tr") { inTr = true; break; }
          p = p.parent;
        }
        const prop = ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(src) : "";
        if (!inTr && !["label", "tip", "menu", "title"].includes(prop) && !ts.isImportDeclaration(n.parent) && !ts.isJsxAttribute(n.parent)) {
          const { line } = src.getLineAndCharacterOfPosition(n.getStart(src));
          console.log(`${file}:${line + 1}: ${text.slice(0, 90)}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
