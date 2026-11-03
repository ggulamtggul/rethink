// Builds external driver .ts files into loadable .js drivers.
//
//   node scripts/build-drivers.mjs [sourceDir] [outDir]
//   defaults: examples/external-drivers -> examples/external-drivers/dist
//
// This is a transpile-only build on purpose: a driver is a plugin, compiled
// on its own. Pulling the server's sources into the driver's program (what a
// full tsc project build does with the path mappings) makes tsc emit copies
// of the server next to the driver and trip over rootDir rules. Type
// checking still happens in your editor, and with
// `tsc -p examples/external-drivers/tsconfig.json` (noEmit) before building.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const srcDir = process.argv[2] ?? 'examples/external-drivers'
const outDir = process.argv[3] ?? join(srcDir, 'dist')

mkdirSync(outDir, { recursive: true })

let failed = false
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    const source = readFileSync(join(srcDir, file), 'utf-8')
    const { outputText, diagnostics } = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 },
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    if (errors.length > 0) {
        failed = true
        for (const d of errors) console.error(file + ':', ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        continue
    }
    const outFile = join(outDir, file.replace(/\.ts$/, '.js'))
    writeFileSync(outFile, outputText)
    console.log(file, '->', outFile)
}
if (failed) process.exit(1)
