<!--
For Node's API: a node: module in node/prelude, the host primitives it calls (node/src), and
node/compat.json.
-->

## Problem

<!-- Which module or functions are missing or behave differently from Node, and what needs them:
     a package, an app, one of Node's tests. -->

## Proposal

<!-- How it is built: JS in the prelude, host primitives in C, or the runtime's. Whether it is
     ported from Node's lib/ (which file, which Node version). -->

## Example

```js

```

<!-- Its output under Node and under visaljs. -->

## Node's tests

<!-- The tests in tests/nodejs that newly pass (`npm run nodejs -- --failures <test>`), and the
     ones that still fail, with why. -->

## Compatibility

<!-- What node/compat.json says before and after (`node tests/compat/node.ts`), and what stays
     unsupported, with why. -->

## Size

<!-- Stripped binary sizes, main vs this branch: hello world, a program using the module, and
     tests/apps/express. A large or rarely used part goes in its own module, linked only into
     programs that name it (internal/features.js, implicitModules in node/index.ts). -->

| Program | main | this branch | change |
|---|---|---|---|
| hello world | | | |
| | | | |
| express | | | |

## Checklist

- [ ] Tests in tests/nodejs pass, and `node.results` is updated (`--update`)
- [ ] `node/compat.json` regenerated
- [ ] A file ported from Node.js says so at its top, with Node's license (node/third_party/nodejs)
- [ ] Binary sizes measured, with the numbers above
- [ ] `npm run lint` and `npm run typecheck` pass
