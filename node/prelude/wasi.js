// node:wasi: WASI runs WebAssembly modules, which visaljs doesn't provide.
import { notSupported } from "./internal/errors.js";

export class WASI {
  constructor() {
    throw notSupported("WASI (WebAssembly)");
  }
}

export default { WASI };
