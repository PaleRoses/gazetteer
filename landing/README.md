# Gazetteer landing

A self-contained Vite + TypeScript page: a dot-matrix globe (d3-geo orthographic over world-atlas land-110m, drawn on a canvas) with pixel sprites for the ships, ports and the watching robot.

```sh
cd landing
../node_modules/.bin/bun install
node_modules/.bin/vite --host 127.0.0.1 --port 5190 --strictPort   # dev
node_modules/.bin/tsc --noEmit && node_modules/.bin/vite build      # dist/
```

`VITE_APP_URL` (default `/`) is the app's base URL; `World` and `Ask the operational leader` go to `<base>/demo`, `Relay` to `<base>/demo#actor-board`.

Headless Chrome on macOS never ticks `requestAnimationFrame`, so in dev the page accepts `?headless`, which drives frames from timers (for `--screenshot` with `--virtual-time-budget`). Production builds drop it.
