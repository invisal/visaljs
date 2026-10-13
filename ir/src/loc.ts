// A source position: where an AST node, an IR instruction or an emitted C line comes from.
export interface Loc {
  file: string;
  line: number;
  column: number;
}
