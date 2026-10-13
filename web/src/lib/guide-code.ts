// The guide's fenced code blocks become <CodeBlock>s, at build time. The fence names the
// language (js, c or text, the last for diagrams) and may give a label (```c label="Making");
// a line starting with "+ " is new in this step: highlighted, and the "+ " is dropped.

interface Code {
  type: "code";
  lang?: string | null | undefined;
  meta?: string | null | undefined;
  value: string;
}

interface Context {
  replaceNode(node: Code, replacement: object): void;
}

const LANGS: Record<string, [lang: string, label: string]> = { js: ["javascript", "JavaScript"], c: ["c", "C"], text: ["text", ""] };

export const guideCode = {
  name: "guide-code",
  code(node: Code, ctx: Context) {
    const [lang, fallback] = LANGS[node.lang ?? "text"] ?? LANGS.text!;
    const label = /label="([^"]*)"/.exec(node.meta ?? "")?.[1] ?? fallback;
    const marks: number[] = [];
    const code = node.value
      .split("\n")
      .map((l, i) => {
        if (!l.startsWith("+ ")) return l;
        marks.push(i);
        return l.slice(2);
      })
      .join("\n");
    const attr = (name: string, value: string) => ({ type: "mdxJsxAttribute", name, value });
    const expr = (name: string, value: string) => ({ type: "mdxJsxAttribute", name, value: { type: "mdxJsxAttributeValueExpression", value } });
    ctx.replaceNode(node, {
      type: "mdxJsxFlowElement",
      name: "CodeBlock",
      attributes: [attr("label", label), attr("lang", lang), attr("code", code), expr("marks", JSON.stringify(marks))],
      children: [],
    });
  },
};
