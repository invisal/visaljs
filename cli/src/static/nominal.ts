// Static code's classes are nominal: a Point is what `new Point` makes, never an object of its
// shape (tsc's structural typing lets one in, and a class's code will rely on its own layout).
// tsc is told so by a brand: each class merges with an interface of one property, keyed by a
// symbol no source can name, whose type is that class's own. The interfaces are appended to the
// file's text, so no position the unit's locations and errors use moves.
import { resolve } from "node:path";

import ts from "typescript";

import { isStaticSource } from "./boundary.ts";

/** The brand's key: a global symbol only the brands file declares. */
export const BRAND = "$visaljs$nominal";

const BRANDS_FILE = resolve(import.meta.dirname, "visaljs-brands.d.ts");

/** The unit's files as tsc's program sees them, and the static files they import: branded. */
export function nominalProgram(files: readonly string[], extraRoots: readonly string[], options: ts.CompilerOptions): ts.Program {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) => {
    if (resolve(name) === BRANDS_FILE) return ts.createSourceFile(name, `declare const ${BRAND}: unique symbol;\n`, language);
    const sf = getSourceFile(name, language, ...rest);
    if (!sf || !isStaticSource(name, sf.text)) return sf;
    const brands = sf.statements.filter((st): st is ts.ClassDeclaration & { name: ts.Identifier } => ts.isClassDeclaration(st) && st.name !== undefined).map((c) => {
      const parameters = c.typeParameters ? `<${c.typeParameters.map((p) => p.getText(sf)).join(", ")}>` : "";
      const exported = ts.getModifiers(c)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? "export " : "";
      return `${exported}interface ${c.name.text}${parameters} { readonly [${BRAND}]: ${JSON.stringify(`${c.name.text}@${resolve(name)}:${c.pos}`)} }\n`;
    });
    return brands.length ? ts.createSourceFile(name, `${sf.text}\n${brands.join("")}`, language) : sf;
  };
  return ts.createProgram([...files, ...extraRoots, BRANDS_FILE], options, host);
}

/** A diagnostic of tsc's that a brand caused, in static code's words. */
export function nominalDiagnostic(d: ts.Diagnostic): ts.Diagnostic {
  const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!text.includes(BRAND)) return d;
  const missing = /missing in type '(.*)' but required in type '(.*)'/.exec(text);
  const other = /Type '"([^"@]+)@[^"]*"' is not assignable to type '"([^"@]+)@/.exec(text);
  const [value, cls] = missing ? [missing[1], missing[2]] : other ? [other[1], other[2]] : ["the value", "that class"];
  return { ...d, messageText: `'${value}' isn't a ${cls}: static code's classes are nominal, only \`new ${cls}\` makes one` };
}
