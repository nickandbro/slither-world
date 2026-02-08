import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import JavaScriptObfuscator from 'javascript-obfuscator'

import { cloudflare } from '@cloudflare/vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cloudflare({ configPath: 'wrangler.dev.toml' }),
    clientObfuscationPlugin(isTruthyEnv(readBuildEnv('OBFUSCATE_CLIENT'))),
  ],
  build: {
    rollupOptions: {
      output: {
        // Keep vendor libraries (notably three.js) in a separate chunk so client obfuscation
        // can target only our app code without touching performance-critical dependencies.
        manualChunks(id) {
          if (id.replaceAll('\\', '/').includes('/node_modules/')) {
            return 'vendor'
          }
        },
      },
    },
  },
})

function clientObfuscationPlugin(enabled: boolean): Plugin {
  return {
    name: 'client-obfuscation',
    apply: 'build',
    enforce: 'post',
    generateBundle(outputOptions, bundle) {
      if (!enabled) return

      const outputDir = (outputOptions.dir ?? '').replaceAll('\\', '/')
      if (!outputDir.includes('/dist/client')) {
        return
      }

      let obfuscatedCount = 0
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk' || !item.fileName.endsWith('.js')) {
          continue
        }

        // The goal is minimal obfuscation that doesn't risk perturbing WebGL/WebGPU
        // performance-critical library code. Only obfuscate chunks that are pure app (`src/`)
        // code and contain no `node_modules/` modules.
        const moduleIds = item.moduleIds ?? []
        const hasAppSrcModule = moduleIds.some((id) => id.replaceAll('\\', '/').includes('/src/'))
        const hasNodeModules = moduleIds.some((id) => id.replaceAll('\\', '/').includes('/node_modules/'))
        if (!hasAppSrcModule || hasNodeModules) {
          continue
        }

        const result = JavaScriptObfuscator.obfuscate(item.code, {
          compact: true,
          controlFlowFlattening: false,
          deadCodeInjection: false,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          // Keep runtime behavior and performance as close as possible to the non-obfuscated build.
          // These transforms can introduce runtime overhead and hamper JIT optimizations.
          splitStrings: false,
          stringArray: false,
          target: 'browser-no-eval',
          transformObjectKeys: false,
        })

        item.code = result.getObfuscatedCode()
        obfuscatedCount += 1
      }

      this.info(`obfuscated ${obfuscatedCount} client chunk(s)`)
    },
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true'
}

function readBuildEnv(name: string): string | undefined {
  const candidate = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.[name]
  return candidate
}
