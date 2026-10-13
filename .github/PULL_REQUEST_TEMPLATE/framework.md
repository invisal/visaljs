<!--
For a framework plugin (cli/src/frameworks): `visaljs build <project directory>` building a
framework's production server. A plugin implements the Framework hooks: detect, build, entry,
plugins, requires, notes.
-->

## Framework

<!-- Its name, the version supported, and a link to it. -->

## Problem

<!-- What happens today when a project on this framework is built: the error, or what the binary
     gets wrong. -->

## Proposal

<!-- Which hooks it implements and why each one is needed: how it is detected, the framework's
     own build it runs, the entry that starts its server, the code it rewrites for the bundler,
     the packages it require()s at run time. -->

## App

<!-- The app in tests/apps that exercises it, and what it covers: routes, rendering, data,
     static files. -->

## Results

<!-- The HTTP differential test: the app's responses under Node and compiled, compared. Binary
     size, startup and requests per second against Node (`npm run bench:servers -- <app>`). -->

| | Node | visaljs |
|---|---|---|
| Binary size | | |
| Startup | | |
| Requests per second | | |

## Limits

<!-- What doesn't work under visaljs, and the notes the build report shows users about it. -->

## Checklist

- [ ] The app builds with `visaljs build` from its directory, with no extra steps
- [ ] The differential test passes: the same responses as under Node
- [ ] Detection matches this framework's projects only (another framework's project, or none, is untouched)
- [ ] `npm run lint` and `npm run typecheck` pass
