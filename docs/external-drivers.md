# External device drivers

Built-in drivers live in `cloud/devices/` and are registered statically in
`cloud/ha_bridge.ts`, so supporting a new model used to mean rebuilding the
server. The external driver loader removes that step: compiled driver files
in a folder are loaded at startup and used alongside (or instead of) the
built-ins.

## Enabling

Add one line to `config.jsonc`:

```jsonc
"drivers_dir": "./drivers",
```

Relative paths resolve against the folder holding the config file. The
folder is scanned once at startup; restart the server to pick up changes.

## The driver contract

A driver file is an ESM `.js` module exporting exactly three things:

```ts
export const models: string[] = ['MODEL_ID']       // every modelId handled; aliases go here
export const platform = 'thinq2'                   // or 'thinq1' (default 'thinq2')
export default class extends HADevice { ... }      // the driver class
```

The class follows the same contract as a built-in driver: constructor
`(HA, thinq, meta)`, `setProperty()` for HA→appliance commands, appliance
reports decoded into `HA.publishProperty()` calls. The loader checks the
class structurally (the HADevice method shape on its prototype) rather than
by identity, so a driver never fails for having loaded a different copy of
a module.

Server modules are imported through `rethink/...` specifiers:

```ts
import HADevice from 'rethink/cloud/devices/base'
import AABBDevice from 'rethink/cloud/devices/aabb_device'
import log from 'rethink/util/logging'
```

A driver file sitting in a drivers folder cannot use relative imports — it
does not know where the server lives — so the server maps this prefix onto
its own tree while loading (see `util/rethink-alias-hook.ts`).

Start from `examples/external-drivers/example_model.ts`.

## Building a driver

```sh
npm run build-drivers                       # examples/external-drivers -> examples/external-drivers/dist
node scripts/build-drivers.mjs <src> <out>  # any folder of driver .ts files
```

The build is transpile-only on purpose: a full `tsc` project build would
drag the server's sources into the driver's program and emit copies of them
next to the driver. Type checking is separate:

```sh
npx tsc -p examples/external-drivers/tsconfig.json   # noEmit check for the example folder
```

Then copy the resulting `.js` into `drivers_dir` and restart.

## Precedence and failure behaviour

- An external driver **wins over the built-in driver** for the same model;
  the startup log says so (`shadows the built-in driver for ...`).
- A model claimed by two external files keeps the **first** file (in file
  name order); the second claim is logged and ignored.
- A file that fails to import, or does not match the contract, is logged
  with its file name, the first 8 characters of its sha256, and the reason —
  and loading continues with the remaining files. One broken driver never
  stops the server or the other drivers.
- A driver whose constructor or `start()` throws costs only that device:
  the bridge logs the failure and carries on without a driver for it.
- Every load ends with a summary line: files seen, models registered,
  failures.

## Verifying a new driver

1. Restart and read the startup log: your file should appear with its hash
   and model list, and the summary should show no new failures.
2. Connect the appliance and compare what the driver publishes in Home
   Assistant against the LG cloud values (the official ThinQ integration or
   the app) at the same moment. Do not enable control paths until the read
   side matches.
3. Open control (`setProperty`) for reversible actions first, with the
   appliance attended.
