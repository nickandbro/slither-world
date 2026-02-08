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

        const result = JavaScriptObfuscator.obfuscate(item.code, {
          compact: true,
          controlFlowFlattening: false,
          deadCodeInjection: false,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          splitStrings: true,
          splitStringsChunkLength: 8,
          stringArray: true,
          stringArrayEncoding: ['base64'],
          stringArrayThreshold: 0.8,
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
