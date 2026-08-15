/**
 * dsh-ocr plugin, enhanced with Doubao vision understanding.
 *
 * The original plugin only provided the `ocr` service and relied on a local
 * patch inside `@deepseek-ai/dsh-llm-deepseek` (the adapter seam).  This
 * version keeps that service for compatibility, and additionally installs an
 * `llm/stream` waterfall hook that converts image blocks into text blocks
 * before the DeepSeek text-only adapter serializes the request.  The result:
 *
 *   - text-heavy images  -> local RapidOCR (fast) or DeepSeek-OCR-2 (deep)
 *   - life-scene images  -> optional Doubao vision model understanding,
 *                           merged with the native OCR output
 *
 * No changes to the installed dsh adapter package are required.
 *
 * Doubao supports two backends:
 *   1. Volcengine Ark API key (recommended, no browser):
 *        DOUBAO_ARK_API_KEY=...
 *        DOUBAO_ARK_MODEL=doubao-seed-1.6-vision-250815
 *   2. Doubao web account login via Playwright:
 *        python tools/doubao_vision.py login
 *      The persistent login profile is reused by the plugin automatically.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const name = 'dsh-ocr'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const DEFAULT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'ocr_image.py')
const DEFAULT_DOUBAO_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'doubao_vision.py')

const MEDIA_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const DOUBAO_MARKERS = ['[豆包识图]', '[视觉识图]', '[豆包理解]', '[豆包]']
const DEEP_MARKERS = ['[深度识图]']

function envList(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function sanitizeKey(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)
}

function buildOcrEnv() {
  const env = { ...process.env }
  if (process.env.DSH_OCR_PYTHONPATH !== undefined) env.PYTHONPATH = process.env.DSH_OCR_PYTHONPATH
  if (process.env.DSH_OCR_LD_LIBRARY_PATH !== undefined) env.LD_LIBRARY_PATH = process.env.DSH_OCR_LD_LIBRARY_PATH
  return env
}

function buildDoubaoEnv() {
  const env = buildOcrEnv()
  if (process.env.DOUBAO_PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    env.PLAYWRIGHT_BROWSERS_PATH = process.env.DOUBAO_PLAYWRIGHT_BROWSERS_PATH
  }
  if (process.env.DOUBAO_PROFILE !== undefined) env.DOUBAO_PROFILE = process.env.DOUBAO_PROFILE
  return env
}

function spawnLog(error) {
  return error instanceof Error ? error.message : String(error)
}

/** True when a content block list contains image blocks (walks tool results). */
function contentHasImage(blocks) {
  if (!Array.isArray(blocks)) return false
  return blocks.some((block) => {
    if (block === null || typeof block !== 'object') return false
    if (block.type === 'image') return true
    if (block.type === 'tool-result') return contentHasImage(block.content)
    return false
  })
}

/** Collect visible text from a content-block list, including tool results. */
function collectText(blocks) {
  let out = ''
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') out += block.text ?? ''
    else if (block.type === 'tool-result') out += collectText(block.content)
  }
  return out
}

function hasAnyMarker(text, markers) {
  return markers.some((marker) => text.includes(marker))
}

/** Strip OCR presentation noise and count meaningful characters. */
function meaningfulTextLength(text) {
  const cleaned = String(text)
    .replace(/\[[\d.]+\]\s*/g, '')
    .replace(/@-?\d+,-?\d+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
  return cleaned.length
}

function ocrContentLength(text) {
  const lines = String(text).split('\n')
    .filter((line) => !line.startsWith('[图像信息]') && !line.startsWith('【版面说明】'))
  return meaningfulTextLength(lines.join('\n'))
}

function isSparse(text, threshold) {
  return ocrContentLength(text) < threshold
}

function shortAttachmentId(id) {
  const value = String(id ?? '')
  return value.length > 16 ? value.slice(0, 16) : value
}

async function readStoredImage(ctx, ref) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('attachment store unavailable')
  return attachments.readImage(ref)
}

/** Parse fast-OCR stdout: OCR lines + a compact native visual-info line. */
function parseFastOcr(stdout) {
  if (typeof stdout !== 'string') return ''
  if (stdout.includes('分析失败:')) return ''
  const lines = stdout.split('\n')
  const parts = []
  let meta = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('# 文件:')) continue
    if (line.startsWith('# 尺寸:')) {
      meta += line.slice(1).trim().replace(/^尺寸:\s*/, '尺寸 ')
      continue
    }
    if (line.startsWith('# 主色调:')) {
      meta += `；主色调 ${line.slice(1).trim().replace(/^主色调:\s*/, '')}`
      continue
    }
    const match = /^\[[\d.]+]\s?(.*)$/.exec(line)
    if (match === null) continue
    const text = match[1].trim()
    if (text.length > 0) parts.push(text)
  }
  if (meta.length > 0) parts.unshift(`[图像信息] ${meta}`)
  return parts.join('\n').slice(0, 8000)
}

/** Fast OCR runner (RapidOCR via ocr_image.py), cached by attachment id. */
function createOcrImage(ctx) {
  const execFileP = promisify(execFile)
  const python = process.env.DSH_OCR_PYTHON ?? 'python3'
  const script = process.env.DSH_OCR_SCRIPT ?? DEFAULT_SCRIPT
  const cache = new Map()
  const inflight = new Map()
  const CACHE_LIMIT = 128

  async function run(ref) {
    const key = String(ref.attachmentId)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const pending = inflight.get(key)
    if (pending !== undefined) return pending
    const task = (async () => {
      let text = ''
      try {
        const stored = await readStoredImage(ctx, ref)
        const dir = path.join(DSH_HOME, 'attachments', 'ocr-tmp')
        await fs.mkdir(dir, { recursive: true })
        const ext = MEDIA_EXT[ref.mediaType] ?? 'png'
        const file = path.join(dir, `${sanitizeKey(key)}.${ext}`)
        await fs.writeFile(file, stored.data)
        try {
          const { stdout } = await execFileP(python, [script, file], {
            timeout: 40_000,
            maxBuffer: 4 * 1024 * 1024,
            env: buildOcrEnv(),
          })
          text = parseFastOcr(stdout)
        } finally {
          await fs.rm(file, { force: true }).catch(() => {})
        }
      } catch (error) {
        ctx.logger?.warn(`dsh-ocr: fast OCR failed for ${key}: ${spawnLog(error)}`)
      }
      cache.set(key, text)
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      return text
    })()
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }
  return run
}

/** Deep OCR runner (DeepSeek-OCR-2 via llama-mtmd-cli), disk-cached. */
function createOcrDeep(ctx) {
  const execFileP = promisify(execFile)
  const bin = process.env.DSH_OCR2_BIN ?? 'llama-mtmd-cli'
  const model = process.env.DSH_OCR2_MODEL ?? path.join(DSH_HOME, 'models', 'ocr2', 'DeepSeek-OCR-2-IQ4_NL.gguf')
  const mmproj = process.env.DSH_OCR2_MMPROJ ?? path.join(DSH_HOME, 'models', 'ocr2', 'mmproj-deepseek-ocr-2-q8_0.gguf')
  const cacheDir = process.env.DSH_OCR2_CACHE ?? path.join(DSH_HOME, 'attachments', 'ocr2-cache')
  const cache = new Map()
  const inflight = new Map()
  const CACHE_LIMIT = 64

  async function run(ref) {
    const key = String(ref.attachmentId)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const pending = inflight.get(key)
    if (pending !== undefined) return pending
    const task = (async () => {
      const cacheFile = path.join(cacheDir, `${sanitizeKey(key)}.txt`)
      let text = ''
      try {
        text = await fs.readFile(cacheFile, 'utf8')
        cache.set(key, text)
        return text
      } catch {
        // no disk cache: run deep OCR below
      }
      try {
        const stored = await readStoredImage(ctx, ref)
        const dir = path.join(DSH_HOME, 'attachments', 'ocr2-tmp')
        await fs.mkdir(dir, { recursive: true })
        const ext = MEDIA_EXT[ref.mediaType] ?? 'png'
        const file = path.join(dir, `${sanitizeKey(key)}.${ext}`)
        await fs.writeFile(file, stored.data)
        try {
          const { stdout } = await execFileP(bin, [
            '-m', model,
            '--mmproj', mmproj,
            '--image', file,
            // Single-sentence prompt: DeepSeek-OCR-2 returns empty output on
            // multi-sentence prompts for small/non-document images.
            '-p', 'Extract all text from this image.',
            '-n', process.env.DSH_OCR2_MAX_TOKENS ?? '1200',
            '--temp', '0',
            '-t', process.env.DSH_OCR2_THREADS ?? '6',
            '-c', '4096',
            '--no-warmup',
            '--jinja',
          ], {
            timeout: 240_000,
            maxBuffer: 16 * 1024 * 1024,
          })
          text = stdout.trim().slice(0, 16_000)
          if (text.length > 0) {
            await fs.mkdir(cacheDir, { recursive: true })
            await fs.writeFile(cacheFile, text)
          }
        } finally {
          await fs.rm(file, { force: true }).catch(() => {})
        }
      } catch (error) {
        ctx.logger?.warn(`dsh-ocr: deep OCR failed for ${key}: ${spawnLog(error)}`)
      }
      cache.set(key, text)
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      return text
    })()
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }
  return run
}

/**
 * Doubao vision runner.
 *
 * Backend order in `auto` mode:
 *   1. Volcengine Ark OpenAI-compatible API when DOUBAO_ARK_API_KEY is set.
 *   2. Doubao web account via tools/doubao_vision.py when a browser profile
 *      already exists (created by `python tools/doubao_vision.py login`).
 */
function createDoubaoVision(ctx) {
  const execFileP = promisify(execFile)
  const python = process.env.DOUBAO_PYTHON ?? process.env.DSH_OCR_PYTHON ?? 'python3'
  const browserScript = process.env.DOUBAO_SCRIPT ?? DEFAULT_DOUBAO_SCRIPT
  const mode = (process.env.DOUBAO_MODE ?? 'auto').toLowerCase()
  const arkApiKey = process.env.DOUBAO_ARK_API_KEY?.trim() ?? ''
  const arkBaseUrl = (process.env.DOUBAO_ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')
  const arkModel = process.env.DOUBAO_ARK_MODEL ?? 'doubao-seed-1.6-vision-250815'
  const arkMaxTokens = process.env.DOUBAO_ARK_MAX_TOKENS ?? '1200'
  const browserProfile = process.env.DOUBAO_PROFILE ?? path.join(DSH_HOME, 'doubao', 'profile')
  const defaultPrompt = [
    '请详细理解这张图片，并直接输出观察结果，不要客套。',
    '如果是文档、截图、表格、票据或文字密集内容：请完整转录可见文字，说明版面结构和表格关系。',
    '如果是自然/生活场景：请描述主体人物或物体、动作、穿着与外观、所处环境、物体之间的空间关系、光线氛围、可见文字，以及画面可能正在发生的事情或想表达的意思。',
    '请把文字转录和场景理解自然地整合在一起，不要省略细节。',
  ].join(' ')
  const prompt = process.env.DOUBAO_PROMPT ?? defaultPrompt

  async function arkDescribe(ref, signal) {
    if (arkApiKey.length === 0) throw new Error('DOUBAO_ARK_API_KEY is empty')
    const stored = await readStoredImage(ctx, ref)
    const base64 = Buffer.from(stored.data).toString('base64')
    const mediaType = ref.mediaType ?? stored.ref.mediaType ?? 'image/png'
    const response = await fetch(`${arkBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${arkApiKey}`,
      },
      body: JSON.stringify({
        model: arkModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
          ],
        }],
        max_tokens: Number(arkMaxTokens) || 1200,
        stream: false,
      }),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Ark API HTTP ${response.status} ${detail.slice(0, 500)}`)
    }
    const payload = await response.json()
    const text = payload?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(`Ark API returned no content: ${JSON.stringify(payload).slice(0, 500)}`)
    }
    return text.trim().slice(0, 12_000)
  }

  async function browserDescribe(ref, signal, imageFile) {
    const args = [
      browserScript, 'ask',
      '--json',
      '--timeout', '180',
      '--image', imageFile,
      '--prompt', prompt,
    ]
    const { stdout } = await execFileP(python, args, {
      timeout: 185_000,
      maxBuffer: 16 * 1024 * 1024,
      env: buildDoubaoEnv(),
      signal,
    })
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    const last = lines[lines.length - 1] ?? ''
    let payload
    try {
      payload = JSON.parse(last)
    } catch {
      throw new Error(`doubao_vision.py did not return JSON: ${stdout.slice(-800)}`)
    }
    if (payload.ok !== true || typeof payload.text !== 'string' || payload.text.trim().length === 0) {
      throw new Error(payload.error ?? 'Doubao web vision returned no text')
    }
    return payload.text.trim().slice(0, 12_000)
  }

  async function configured() {
    if (mode === 'off') return false
    if (mode === 'ark') return arkApiKey.length > 0
    if (mode === 'browser') return true
    if (arkApiKey.length > 0) return true
    return fs.access(browserProfile).then(() => true, () => false)
  }

  async function run(ref, signal) {
    if (mode === 'off') throw new Error('DOUBAO_MODE=off')
    if (mode === 'ark') return arkDescribe(ref, signal)
    if (mode === 'browser') {
      const file = await writeTempImage(ctx, ref, 'doubao-tmp')
      try {
        return await browserDescribe(ref, signal, file)
      } finally {
        await fs.rm(file, { force: true }).catch(() => {})
      }
    }
    if (arkApiKey.length > 0) return arkDescribe(ref, signal)
    if (await fs.access(browserProfile).then(() => true, () => false)) {
      const file = await writeTempImage(ctx, ref, 'doubao-tmp')
      try {
        return await browserDescribe(ref, signal, file)
      } finally {
        await fs.rm(file, { force: true }).catch(() => {})
      }
    }
    throw new Error('Doubao vision is not configured. Set DOUBAO_ARK_API_KEY, or run: python tools/doubao_vision.py login')
  }

  return { run, configured, mode }
}

async function writeTempImage(ctx, ref, subdir) {
  const stored = await readStoredImage(ctx, ref)
  const dir = path.join(DSH_HOME, 'attachments', subdir)
  await fs.mkdir(dir, { recursive: true })
  const ext = MEDIA_EXT[ref.mediaType] ?? 'png'
  const file = path.join(dir, `${sanitizeKey(ref.attachmentId)}-${Date.now()}.${ext}`)
  await fs.writeFile(file, stored.data)
  return file
}

/** Format one recognized image as model-facing text. */
function formatImageText(ref, sections, errors = []) {
  const label = ref.name?.trim() || 'image'
  const id = shortAttachmentId(ref.attachmentId)
  let head
  if (sections.length === 0) {
    head = `[图片OCR 附件 ${label} ${id}]`
  } else if (sections.length === 1 && sections[0].kind === 'doubao') {
    head = `[豆包识图 附件 ${label} ${id}]`
  } else if (sections.length === 1 && sections[0].kind === 'deep') {
    head = `[深度OCR 附件 ${label} ${id}]`
  } else if (sections.length === 1 && sections[0].kind === 'fast') {
    head = `[图片OCR 附件 ${label} ${id}]`
  } else {
    head = `[图片理解 附件 ${label} ${id}]`
  }
  const body = sections.map((section) => `【${section.label}】\n${section.text}`).join('\n\n')
  const errorLine = errors.length > 0 ? `\n[识别错误] ${errors.join('；')}` : ''
  return `${head}\n${body}${errorLine}`.slice(0, 20_000)
}

/**
 * Recognize one image.  Native OCR and Doubao vision are merged here.
 *
 * @param fast - fast OCR runner
 * @param deep - deep OCR runner
 * @param doubao - Doubao vision runner
 * @param ref - attachment reference
 * @param flags - { useDeep, useDoubao }
 * @param signal - optional AbortSignal
 */
async function recognizeImage(fast, deep, doubao, ctx, ref, flags, signal) {
  const useDeep = flags.useDeep
  const useDoubao = flags.useDoubao
  const sceneThreshold = Number(process.env.DSH_OCR_SCENE_MIN_TEXT ?? 12) || 12
  const autoDoubao = (process.env.DOUBAO_AUTO ?? 'auto') !== '0' && (process.env.DOUBAO_AUTO ?? 'auto') !== 'false'
  const sections = []
  const errors = []

  // Native understanding: fast OCR is always useful (text, layout, colors).
  let fastText = ''
  if (!useDeep || process.env.DSH_OCR_RUN_FAST_WITH_DEEP !== '0') {
    try {
      fastText = await fast(ref, signal)
      if (fastText.length > 0) {
        sections.push({ kind: 'fast', label: '本地 OCR（RapidOCR）', text: fastText })
      }
    } catch (error) {
      errors.push(`本地OCR失败: ${spawnLog(error)}`)
    }
  }

  if (useDeep) {
    try {
      const deepText = await deep(ref, signal)
      if (deepText.length > 0) {
        sections.push({ kind: 'deep', label: '深度 OCR（DeepSeek-OCR-2）', text: deepText })
      }
    } catch (error) {
      errors.push(`深度OCR失败: ${spawnLog(error)}`)
    }
  }

  const nativeText = sections.filter((section) => section.kind === 'fast' || section.kind === 'deep')
    .map((section) => section.text).join('\n')
  const configured = await doubao.configured().catch(() => false)
  const needDoubao = configured && (
    useDoubao ||
    (autoDoubao && isSparse(nativeText, sceneThreshold))
  )

  if (needDoubao) {
    try {
      const doubaoText = await doubao.run(ref, signal)
      if (doubaoText.length > 0) {
        sections.push({ kind: 'doubao', label: '豆包视觉理解', text: doubaoText })
      }
    } catch (error) {
      const hint = doubao.mode === 'ark'
        ? '检查 DOUBAO_ARK_API_KEY / DOUBAO_ARK_MODEL'
        : '请先运行: python tools/doubao_vision.py login'
      errors.push(`豆包视觉失败: ${spawnLog(error)}；${hint}`)
      ctx.logger?.warn(`dsh-ocr: Doubao vision failed for ${shortAttachmentId(ref.attachmentId)}: ${spawnLog(error)}`)
    }
  } else if (useDoubao) {
    errors.push('豆包视觉未配置。设置 DOUBAO_ARK_API_KEY，或先执行 tools/doubao_vision.py login')
    ctx.logger?.info(`dsh-ocr: [豆包识图] requested but Doubao is not configured; sending native OCR only`)
  } else if (autoDoubao && isSparse(nativeText, sceneThreshold) && !configured) {
    ctx.logger?.info(
      `dsh-ocr: image ${shortAttachmentId(ref.attachmentId)} looks like a life-scene image (${ocrContentLength(nativeText)} chars OCR); ` +
      'set DOUBAO_ARK_API_KEY or run tools/doubao_vision.py login to add Doubao vision understanding',
    )
  }

  return formatImageText(ref, sections, errors)
}

/** Clone messages and replace image blocks with OCR/vision text blocks. */
async function transformMessages(options, fast, deep, doubao, ctx, signal) {
  const nextMessages = []
  let changed = false

  async function transformBlocks(blocks, flags) {
    if (!Array.isArray(blocks)) return blocks
    let localChanged = false
    const out = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') {
        out.push(block)
        continue
      }
      if (block.type === 'image') {
        localChanged = true
        const text = await recognizeImage(fast, deep, doubao, ctx, block.attachment, flags, signal)
        out.push({ type: 'text', text })
        continue
      }
      if (block.type === 'tool-result' && contentHasImage(block.content)) {
        localChanged = true
        out.push({ ...block, content: await transformBlocks(block.content, flags) })
        continue
      }
      out.push(block)
    }
    return localChanged ? out : blocks
  }

  for (const message of options.messages) {
    if (!contentHasImage(message.content)) {
      nextMessages.push(message)
      continue
    }
    const text = collectText(message.content)
    const flags = {
      useDeep: hasAnyMarker(text, DEEP_MARKERS),
      useDoubao: hasAnyMarker(text, DOUBAO_MARKERS),
    }
    const content = await transformBlocks(message.content, flags)
    if (content !== message.content) {
      changed = true
      nextMessages.push({ ...message, content })
    } else {
      nextMessages.push(message)
    }
  }
  return changed ? nextMessages : options.messages
}


function ensureImageModalities(info) {
  if (info === null || typeof info !== 'object') return info
  const modalities = info.inputModalities
  if (modalities === undefined) return { ...info, inputModalities: ['text', 'image'] }
  if (modalities.includes('image')) return info
  return { ...info, inputModalities: [...modalities, 'image'] }
}

/**
 * DeepSeek models are text-only on the wire, but this plugin converts every
 * image to text before the adapter is called.  Advertise image input for the
 * selected providers so the harness admission layer accepts image uploads.
 */
function patchLlmImageCapability(ctx, providers, patchStreams) {
  if ((process.env.DSH_OCR_PATCH_MODEL_CAPABILITY ?? '1') === '0') return () => {}
  const patch = () => {
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) return
    try {
      patchStreams?.()
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ocr: failed to patch adapter streams: ${spawnLog(error)}`)
    }
    if (llm[symbols.capability] === true) return
    try {
      for (const method of ['listModels', 'resolveModelInfo', 'resolveModelInfoFor']) {
        const original = llm[method]
        if (typeof original !== 'function') continue
        const bound = original.bind(llm)
        llm[method] = async function patchedLlmMethod(...args) {
          const result = await bound(...args)
          if (method === 'listModels') {
            if (!Array.isArray(result)) return result
            return result.map((model) => providers.includes('*') || providers.includes(model.provider) ? ensureImageModalities(model) : model)
          }
          const provider = typeof args[0] === 'string' ? args[0] : args[0]?.provider?.id
          if (providers.includes('*') || providers.includes(provider)) return ensureImageModalities(result)
          return result
        }
      }
      llm[symbols.capability] = true
      ctx.logger?.info?.('dsh-ocr: image input capability advertised for ' + providers.join(','))
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ocr: failed to patch llm image capability: ${spawnLog(error)}`)
    }
  }
  patch()
  const dispose = ctx.on('llm/adapters-updated', () => patch(), { global: true })
  return dispose
}

/**
 * Wrap each selected adapter's `stream` method at the final adapter boundary.
 * This is the only point where a request can be cloned: `llm/stream` options
 * are frozen by the agent loop, and waterfall listeners cannot replace them.
 * The agent-loop invariant still sees the original durable request before this
 * boundary, while the provider serializer receives the OCR/vision text.
 */
function patchAdapterStreams(ctx, providers, fast, deep, doubao) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || !(llm.adapters instanceof Map)) return
  for (const [provider, registration] of llm.adapters.entries()) {
    if (!(providers.includes('*') || providers.includes(provider))) continue
    const adapter = registration?.adapter
    if (adapter === undefined || adapter === null || adapter[symbols.adapter] === true) continue
    const original = typeof adapter.stream === 'function' ? adapter.stream.bind(adapter) : undefined
    if (original === undefined) continue
    adapter[symbols.adapter] = true
    adapter.stream = function wrappedAdapterStream(options) {
      const hasImages = Array.isArray(options.messages) && options.messages.some((message) => contentHasImage(message?.content))
      if (!hasImages) return original(options)
      return (async function* () {
        const started = Date.now()
        try {
          const messages = await transformMessages(options, fast, deep, doubao, ctx, options.signal)
          if (messages !== options.messages) {
            ctx.logger?.debug?.(`dsh-ocr: image blocks converted for ${provider} in ${Date.now() - started}ms`)
            yield* original({ ...options, messages })
          } else {
            yield* original(options)
          }
        } catch (error) {
          ctx.logger?.warn(`dsh-ocr: adapter image conversion failed for ${provider}, falling back to unmodified request: ${spawnLog(error)}`)
          yield* original(options)
        }
      })()
    }
    ctx.logger?.info?.(`dsh-ocr: patched ${provider} adapter stream for image-to-text conversion`)
  }
}

const symbols = { capability: Symbol.for('dsh-ocr.llm-image-capability'), adapter: Symbol.for('dsh-ocr.adapter-stream') }

export function apply(ctx) {
  const providers = envList('DSH_OCR_PROVIDERS', ['deepseek-official'])
  const fast = createOcrImage(ctx)
  const deep = createOcrDeep(ctx)
  const doubao = createDoubaoVision(ctx)
  const disposeLlmPatch = patchLlmImageCapability(ctx, providers, () => patchAdapterStreams(ctx, providers, fast, deep, doubao))

  // Compatibility with deployments that already carry the adapter OCR seam.
  ctx.provide('ocr', {
    ocrImage: fast,
    ocrDeep: deep,
  })

  ctx.effect(() => async () => {
    disposeLlmPatch()
  }, 'dsh-ocr: llm image capability and adapter stream patch')
}
